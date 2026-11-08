/* Experiment API: calendar emails (iTIP) go out without a compose window, so
   compose.onBeforeSend never sees them. This wraps the transport that sends
   them and lets the add-on send, reroute or drop each one. */
"use strict";

var { ExtensionCommon } = ChromeUtils.importESModule("resource://gre/modules/ExtensionCommon.sys.mjs");
var { MailServices } = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");
var { CalItipEmailTransport } = ChromeUtils.importESModule("resource:///modules/CalItipEmailTransport.sys.mjs");
var { CalAttendee } = ChromeUtils.importESModule("resource:///modules/CalAttendee.sys.mjs");
var { cal } = ChromeUtils.importESModule("resource:///modules/calendar/calUtils.sys.mjs");

const proto = CalItipEmailTransport.prototype;
let original = null;
let decide = null;

function install(listener) {
  decide = listener;
  if (!original) {
    original = proto._sendXpcomMail;
    proto._sendXpcomMail = guardedSend;
  }
}

function uninstall() {
  decide = null;
  if (original) {
    proto._sendXpcomMail = original;
    original = null;
  }
}

function guardedSend(toList, subject, body, itipItem) {
  const send = original;
  if (!decide || itipItem.autoResponse == Ci.calIItipItem.NONE) {
    return send.call(this, toList, subject, body, itipItem);
  }
  const { identity } = this.getIdentityAndAccount(itipItem);
  const serializer = Cc["@mozilla.org/calendar/ics-serializer;1"].createInstance(Ci.calIIcsSerializer);
  serializer.addItems(itipItem.getItemList());
  const request = {
    sender: identity?.email ?? "",
    actor: itipItem.identity ?? "",
    to: toList.map(a => cal.email.getAttendeeEmail(a, false)),
    subject,
    body,
    calendar: serializer.serializeToString(),
  };
  // Nothing is sent until the add-on answered. Any failure drops the email.
  decide(request)
    .then(decision => {
      if (decision?.action == "send") {
        send.call(this, toList, subject, body, itipItem);
      } else if (decision?.action == "rewrite") {
        sendRewritten(this, send, decision, subject, body, itipItem);
      }
    })
    .catch(e => console.error("Alias Buddy: calendar email not sent", e));
  return true;
}

function sendRewritten(transport, send, { identityId, to }, subject, body, itipItem) {
  const identity = MailServices.accounts.allIdentities.find(i => i.key == identityId);
  const account = MailServices.accounts.accounts.find(a => a.identities.some(i => i.key == identityId));
  if (!identity || !account) {
    throw new Error(`identity ${identityId} not found`);
  }
  const attendees = to.map(email => {
    const attendee = new CalAttendee();
    attendee.id = cal.email.prependMailTo(email);
    return attendee;
  });
  const rerouted = Object.create(transport, { getIdentityAndAccount: { value: () => ({ identity, account }) } });
  // The identity's automatic Cc/Bcc would reach SimpleLogin as addresses that
  // are no reverse aliases, and it drops such a message. The transport reads
  // them synchronously, so they are off only during this call.
  const { doCc, doBcc } = identity;
  identity.doCc = false;
  identity.doBcc = false;
  try {
    send.call(rerouted, attendees, subject, body, itipItem);
  } finally {
    identity.doCc = doCc;
    identity.doBcc = doBcc;
  }
}

this.aliasBuddyItip = class extends ExtensionCommon.ExtensionAPI {
  onShutdown() {
    uninstall();
  }

  getAPI(context) {
    return {
      aliasBuddyItip: {
        onSend: new ExtensionCommon.EventManager({
          context,
          name: "aliasBuddyItip.onSend",
          register: fire => {
            install(request => fire.async(request));
            return uninstall;
          },
        }).api(),
      },
    };
  }
};
