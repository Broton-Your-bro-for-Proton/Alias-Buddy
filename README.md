# Alias Buddy for SimpleLogin

A Thunderbird add-on that lets you send as a [SimpleLogin](https://simplelogin.io) alias to normal addresses. It creates and fills in the reverse aliases for you, and it blocks messages that would reveal your real address.

Not affiliated with or endorsed by Proton AG or SimpleLogin.

## How it works

SimpleLogin only sends as an alias when the message comes from one of your mailboxes and goes to a reverse alias of that alias. The add-on does this at the moment you press Send:

1. You pick the alias as sender (a Thunderbird identity with the alias address) and write to the real address of your contact.
2. The add-on looks up the alias, creates the contact through the SimpleLogin API if needed, and replaces every recipient with its reverse alias.
3. It switches the sender to a Thunderbird identity of the alias's mailbox, because SimpleLogin only accepts it from there. It only uses an identity without an OpenPGP key or S/MIME certificate, because Thunderbird decides about signing after the switch, too late for a check.
4. It checks the final state before the message leaves: sender, recipients, Reply-To, vCard, OpenPGP key, signing and the text. Anything that would reveal your mailbox address stops the send.

Your contact sees your alias as sender and their own address as recipient. Your Sent folder keeps the reverse aliases and your mailbox address, as that is what went out.

The Alias Buddy button in the compose window shows what will happen to each recipient. After a blocked send it shows a red mark, and its tooltip says why.

## The guard

Every send goes through the guard:

- **From a real mailbox** (your SimpleLogin mailboxes and any address you add in the settings, also with a +tag or, for Gmail, other dots): only reverse aliases and allowlisted addresses are accepted. Mixing both is blocked too, because SimpleLogin drops such messages. The alias that owns the reverse aliases may stay in Cc, as in a reply to all.
- **On the way through SimpleLogin**, from an alias or a mailbox: a vCard, an attached OpenPGP key, signing or encryption, newsgroups, your real address in the subject, text or a text attachment (for example a forwarded message), and embedded images (their Content-ID carries the mailbox domain) block the message.
- **As an alias**: the message is rewritten as above. A reverse alias that belongs to another alias or a failed final check blocks it.
- **Other identities** are left alone once SimpleLogin confirmed they are not aliases, unless their From or Reply-To shows a real address.
- **SimpleLogin unreachable**: answers from the last 10 minutes are used. Without them the send is blocked.
- **No API key yet**: only the addresses listed in the settings are guarded.

A blocked message stays open. For a leak you may accept, the popup offers to send it once unchanged. That applies only to the message exactly as it was blocked.

### Calendar emails

Thunderbird sends invitations, replies and cancellations without a compose window, from the identity set for the calendar, straight to the other side's real address. The add-on hooks into that through an Experiment API, which is why Thunderbird asks for full access when you install it.

- A calendar email that acts for an alias (you accept an invitation sent to your alias) goes from a mailbox identity to the reverse alias of each recipient, so SimpleLogin delivers it as the alias.
- From a real mailbox the rules of a message apply. A blocked calendar email is dropped, and a notification says why. Answer by email instead, or add an identity for the alias.
- The iCalendar part, the text and the identity's automatic Cc/Bcc are checked too.
- In "ask me" mode Thunderbird's question comes first, as without the add-on.
- If the add-on is not running, calendar emails are not sent, and a message says so.

Not covered: CalDAV servers that schedule themselves (for example Nextcloud, iCloud or Fastmail with server-side scheduling) send the invitation emails from the server, outside Thunderbird. Calendars of other add-ons (EWS, TbSync) are not covered either.

Read receipts need nothing: SimpleLogin removes the request header from every forwarded message, and Thunderbird asks before it sends a receipt.

### What the guard cannot see

- Other add-ons that send mail themselves.
- Binary attachments such as PDF or Office files, which may contain your address.

## Setup

1. Create an API key in the SimpleLogin dashboard under API Keys.
2. Open the add-on settings, paste the key and save. The test lists your protected mailboxes.
3. Add a Thunderbird identity for each alias you want to send as (Account Settings > Manage Identities), in the account whose identity uses the alias's mailbox.
4. If your mailbox identity has an OpenPGP key or S/MIME certificate, add a second identity with the same address and no keys. The add-on sends alias messages from that one.

Creating reverse aliases needs a SimpleLogin plan that allows it.

## Development

Plain JavaScript, no runtime dependencies, no build step for the code.

```bash
npm test                    # unit tests
npm run setup:thunderbird   # downloads Thunderbird 153 ESR into .cache/
npm run test:e2e            # real Thunderbird with a fake SMTP server and a fake SimpleLogin API
npm run build               # dist/aliasbuddy-<version>.xpi
```

`TB_BINARY` points the end-to-end test at another Thunderbird, and `E2E_SCREENSHOTS=<dir>` saves screenshots.

## License

[MPL-2.0](LICENSE)
