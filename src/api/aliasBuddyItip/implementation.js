/* Experiment API: calendar emails (iTIP) go out without a compose window, so
   compose.onBeforeSend never sees them. This wraps the transport that sends
   them and lets the add-on send, reroute or drop each one. The wrapper is in
   place from add-on startup, so nothing goes out unchecked while the
   background page is not listening. */
"use strict";

var { ExtensionCommon } = ChromeUtils.importESModule("resource://gre/modules/ExtensionCommon.sys.mjs");
var { MailServices } = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");
var { CalItipEmailTransport } = ChromeUtils.importESModule("resource:///modules/CalItipEmailTransport.sys.mjs");
var { CalAttendee } = ChromeUtils.importESModule("resource:///modules/CalAttendee.sys.mjs");
var { cal } = ChromeUtils.importESModule("resource:///modules/calendar/calUtils.sys.mjs");

const proto = CalItipEmailTransport.prototype;
let original = null;
let decide = null;

function install() {
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

function alertUser(text) {
  Services.prompt.alert(Services.wm.getMostRecentWindow("mail:3pane"), "Alias Buddy", text);
}

/** The question Thunderbird asks in "ask me" mode, asked right away because a No stops the following emails. */
function confirmSend() {
  let parent = Services.wm.getMostRecentWindow(null);
  if (!parent || parent.closed) {
    parent = cal.window.getCalendarWindow();
  }
  const answer = Services.prompt.confirmEx(
    parent,
    cal.l10n.getLtnString("imipSendMail.title"),
    cal.l10n.getLtnString("imipSendMail.text"),
    Services.prompt.STD_YES_NO_BUTTONS,
    null,
    null,
    null,
    null,
    {}
  );
  return answer == 0;
}

const addressList = list =>
  String(list ?? "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);

function guardedSend(toList, subject, body, itipItem) {
  const send = original;
  if (itipItem.autoResponse == Ci.calIItipItem.NONE) {
    return send.call(this, toList, subject, body, itipItem);
  }
  if (!decide) {
    alertUser("Alias Buddy is not ready, so this calendar email was not sent.");
    return false;
  }
  if (itipItem.autoResponse == Ci.calIItipItem.USER) {
    if (!confirmSend()) {
      return false;
    }
    itipItem.autoResponse = Ci.calIItipItem.AUTO;
  }
  const { identity } = this.getIdentityAndAccount(itipItem);
  const [item] = itipItem.getItemList();
  // Outgoing items carry no identity. A reply holds only the replying
  // attendee, an invitation or cancellation names the organizer.
  const actor = itipItem.responseMethod == "REPLY" ? item?.getAttendees()[0]?.id : item?.organizer?.id;
  const serializer = Cc["@mozilla.org/calendar/ics-serializer;1"].createInstance(Ci.calIIcsSerializer);
  serializer.addItems(itipItem.getItemList());
  const request = {
    sender: identity?.email ?? "",
    actor: cal.email.removeMailTo(actor ?? ""),
    to: toList.map(a => cal.email.getAttendeeEmail(a, false)),
    cc: identity?.doCc ? addressList(identity.doCcList) : [],
    bcc: identity?.doBcc ? addressList(identity.doBccList) : [],
    subject,
    body,
    calendar: serializer.serializeToString(),
  };
  // Nothing is sent until the add-on answered. Anything else drops the email.
  decide(request)
    .then(decision => {
      if (decision?.action == "send") {
        send.call(this, toList, subject, body, itipItem);
      } else if (decision?.action == "rewrite") {
        sendRewritten(this, send, decision, subject, body, itipItem);
      } else if (decision?.action != "drop") {
        throw new Error("the add-on gave no answer");
      }
    })
    .catch(e => alertUser(`This calendar email was not sent: ${e.message}`));
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
  // The transport adds the identity's automatic Cc/Bcc, which SimpleLogin
  // drops the message for, and writes its Reply-To as Return-path. It reads
  // them synchronously, so they are off only during this call. They are
  // identity prefs: should Thunderbird crash inside this call, the identity
  // keeps them off until the user sets them again.
  const saved = {};
  try {
    for (const [key, off] of [["doCc", false], ["doBcc", false], ["replyTo", ""]]) {
      if (identity[key]) {
        saved[key] = identity[key];
        identity[key] = off;
      }
    }
    send.call(rerouted, attendees, subject, body, itipItem);
  } finally {
    Object.assign(identity, saved);
  }
}

this.aliasBuddyItip = class extends ExtensionCommon.ExtensionAPI {
  onStartup() {
    install();
  }

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
            install();
            decide = request => fire.async(request);
            return () => {
              decide = null;
            };
          },
        }).api(),
      },
    };
  }
};
