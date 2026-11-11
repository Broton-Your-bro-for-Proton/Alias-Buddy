# Alias Buddy for SimpleLogin

A Thunderbird add-on that lets you send as a [SimpleLogin](https://simplelogin.io) alias to normal addresses. It creates and fills in the reverse aliases for you, and it blocks messages that would reveal your real address.

Not affiliated with or endorsed by Proton AG or SimpleLogin.

## How it works

SimpleLogin only sends as an alias when the message comes from one of your mailboxes and goes to a reverse alias of that alias. The add-on does this at the moment you press Send:

1. You pick the alias as sender and write to the real address of your contact. The alias can be an existing Thunderbird identity, you can choose or create it in the Alias Buddy popup (see Choosing and creating aliases), or you type it into the From field (see Typing the alias as sender).
2. The add-on looks up the alias, creates the contact through the SimpleLogin API if needed, and replaces every recipient with its reverse alias.
3. It switches the sender to a Thunderbird identity of the alias's mailbox, because SimpleLogin only accepts it from there. It only uses an identity without an OpenPGP key or S/MIME certificate, because Thunderbird decides about signing after the switch, too late for a check.
4. It checks the final state before the message leaves: sender, recipients, Reply-To, vCard, OpenPGP key, signing and the text. Anything that would reveal your mailbox address stops the send.

Your contact sees your alias as sender and their own address as recipient. Your Sent folder keeps the reverse aliases and your mailbox address, as that is what went out.

The Alias Buddy button in the compose window shows what will happen to each recipient. After a blocked send it shows a red mark, and its tooltip says why.

## Choosing and creating aliases

The Alias Buddy popup in the compose window offers:

- **The alias for the recipient's site**, for example for news@shop.amazon.de the alias tied to amazon.de, or a new one. For recipients of several sites, a choice of the site comes first; a reply's reverse alias counts as its contact's site. With several name templates, a choice of the template (the category) follows. The chosen template also applies to the automatic switch when you send this message.
- **An existing alias**, found by searching its address or note.
- **A new alias** with a name, a domain and a mailbox of your choice.

The chosen alias becomes the sender. If Thunderbird has no identity for it yet, the add-on creates one next to the mailbox's identity, labeled "Alias Buddy". These identities stay when the add-on is disabled or removed. Without the add-on, sending from them goes out directly through Thunderbird's default server, with no reverse alias, so delete them (Account Settings > Manage Identities) before you disable the add-on.

Pressing Send while a popup action is still running (for example while a new alias is created) stops the send with a note to send again, because the sender may have changed meanwhile.

### Typing the alias as sender

Both ways work side by side, nothing to switch: with "Customize From Address" in the sender menu you can type any alias into the From field. On sending, an existing alias is used as it is. An address on one of your own domains that is not an alias yet becomes exactly that alias, with the mailbox for new aliases. Either way the message goes out through the alias's mailbox like any alias message, so no identity is needed. Any other address changes nothing: the guard checks the message by its identity, as before. If SimpleLogin cannot tell whether the typed address is an alias, the send is blocked.

The settings set the defaults:

- **Domain for new aliases**: your own domains and subdomains (used as they are, for example shop.k7f2@yourdomain.com) or SimpleLogin's shared domains (SimpleLogin adds a random word).
- **Mailbox for new aliases**: by default SimpleLogin's default mailbox.
- **Name templates**, one per line, for example one per category: shop.{domain}, news.{domain}, account.{domain}. Each needs at least one placeholder. {domain} is the recipient's site without its ending, {random} five random characters, {word} a random word. The first template is the default for the automatic behavior; the popup offers all of them. The default {domain}.{random} gives readable names that cannot be guessed. A template without random parts gives one fixed name per site; an alias with that name that you created yourself is used as it is, so an existing scheme like shop.amazon@yourdomain.com keeps working.

And the automatic behavior, each one can be turned off:

- **One alias per recipient site and template.** The add-on writes "Alias Buddy: amazon.de (shop.{domain})" into the alias note in SimpleLogin and finds the alias by it, so it works on every device and each category keeps its own alias, whatever the order of the templates. Notes from version 0.3 ("Alias Buddy: amazon.de") count for {domain}.{random}. On by default.
- **Switch instead of block.** Sending from your real address to a new recipient makes the add-on create or reuse the alias for that recipient's site and send as it. Off by default, because it replaces the block. It switches only when all such recipients belong to one site and no allowlisted recipient is in the message, and it checks the message against the planned alias first, so nothing is created for a message that would be blocked anyway. Only SimpleLogin's own refusals come later: without a plan that allows reverse aliases, the alias is created and the message is still blocked. A reverse alias on a domain the add-on has never seen a reverse alias on counts as a site of its own, so the switch can create an alias for it before SimpleLogin refuses the contact. The popup still offers to send from your real address instead.
- **Reply and forward as the alias.** A reply to or forward of a message that came through an alias gets that alias as sender. On by default.
- **Create identities.** On by default. Without it, the add-on only uses identities you added yourself.
- **Reverse aliases in the address book.** Each reverse alias the add-on sends to, and the sender of a confirmed received message, gets a card in the address book "Alias Buddy", named like "[shop.amazon@yourdomain.com] bea@example.com". Thunderbird then shows that name instead of the reverse alias in message lists, the Sent folder and the message header. It also suggests the card when you type the contact's address; pick it only when you write from that alias or its mailbox. A contact with one of your own addresses gets no card, and a reverse alias of your own address next to other recipients in To or Cc blocks the message, because SimpleLogin would show them your address. On by default.

## Alias overview

The Aliases button in Thunderbird's main toolbar (also linked from the popup and the settings) opens a tab with all your aliases:

- Search by address, note or name, and show all, enabled, disabled or pinned aliases. Page through the list with 20, 50 or 100 per page.
- The list comes from a copy in your Thunderbird profile. The add-on updates it slowly in the background (SimpleLogin allows only a few dozen alias requests per minute, and the guard needs them when you send): new aliases when you open the page, everything every six hours or with **Update now**. A search also asks SimpleLogin and adds what the copy lacks.
- Per alias: its mailboxes, how many messages it received, sent and blocked, and the last activity.
- Edit the note in place, pin it, turn it off (it stops receiving mail) or on again.
- **Contacts** lists who the alias wrote to or got mail from, with their reverse alias. A contact can be blocked (SimpleLogin drops its mail) or deleted.
- **Write** opens a new message with the alias as sender, creating its identity if needed. A turned-off alias cannot be used, because replies to it would not arrive. **Copy** copies the address.
- **Delete** asks for a second click (a double click does not count). Depending on your SimpleLogin setting the alias goes to its trash first or is deleted right away; either way the address cannot be created again. Turning an alias off is the gentler choice.
- **Tidy up** (below the list, with a second click) removes the identities the add-on created, except those of open messages, so the sender list stays short. They come back when you use their alias again. A draft from such an alias opens with your default sender and is checked again on send.
- After deleting, the add-on removes the identities it created for the alias. Sending from an identity of a deleted alias, or from one of the add-on's identities whose alias is gone, is blocked: it would go out directly, past SimpleLogin. An identity you created yourself stays; delete it in the account settings.

## Received messages

The Alias Buddy button above a message names the alias it came through. It trusts SimpleLogin's X-SimpleLogin-Envelope-To header only when the sender is a reverse alias of that alias; a message that merely names your alias says "Unconfirmed alias", and a direct message shows "No alias". Its popup blocks or unblocks the sender for this alias and turns the alias off or on, for example when a shop passed your address on.

## The guard

Every send goes through the guard:

- **From a real mailbox** (your SimpleLogin mailboxes and any address you add in the settings, also with a +tag, for Gmail with other dots, and for Proton under proton.me, protonmail.com, protonmail.ch or pm.me): only reverse aliases and allowlisted addresses are accepted. Mixing both in To and Cc is blocked too, because SimpleLogin drops such messages. Bcc does not count, SimpleLogin never sees it. The alias that owns the reverse aliases may stay in Cc, as in a reply to all. The reverse aliases must belong to one alias, and the mailbox must be one of that alias's mailboxes. In a reply, the alias the message came through is read from SimpleLogin's X-SimpleLogin-Envelope-To header, and only trusted when the sender is a reverse alias of that alias.
- **On the way through SimpleLogin**, from an alias or a mailbox: a vCard, an attached OpenPGP key, signing or encryption, newsgroups, your real address in the subject, text or a text attachment (for example a forwarded message, a .txt, .csv, .json or .svg file, in UTF-8 or UTF-16, up to 10 MB; a larger one blocks), embedded images, background images and files (their Content-ID carries the mailbox domain), and a reply to a message whose Message-ID ends in the mailbox domain, such as your own sent message (SimpleLogin keeps In-Reply-To as it is), block the message.
- **As an alias**: the message is rewritten as above. Your real address as a recipient (for example the identity's automatic Cc), a reverse alias that belongs to another alias, or a failed final check blocks it.
- **Other identities** are left alone once SimpleLogin confirmed they are not aliases, unless their From or Reply-To shows a real address. An identity on one of your own SimpleLogin domains that is not an alias is blocked, because it would send directly; create the alias in the popup first.
- **SimpleLogin unreachable** (no connection, rate limit, server error): answers are refreshed after 10 minutes. During an outage answers up to a day old are used, otherwise the send is blocked.
- **No API key yet**: only the addresses listed in the settings are guarded. The add-on's alias identities and deleted aliases are blocked, because they would send directly.

A blocked message stays open. For a leak you may accept, the popup offers to send it once unchanged. That accepts only the reason it shows, which names the recipients or leaks it is about. Every other check still runs, so a second reason, or a changed message with a new reason, blocks again and needs its own decision.

### Calendar emails

Thunderbird sends invitations, replies and cancellations without a compose window, from the identity set for the calendar, straight to the other side's real address. The add-on hooks into that through an Experiment API, which is why Thunderbird asks for full access when you install it.

- A calendar email that acts for an alias (you accept an invitation sent to your alias) goes from a mailbox identity to the reverse alias of each recipient, so SimpleLogin delivers it as the alias. The mailbox identity must not add automatic Cc/Bcc or a Reply-To, because the calendar transport adds them unchecked. While Thunderbird is offline such a calendar email is not sent.
- From an identity of a deleted alias, or from one of the add-on's alias identities when SimpleLogin does not confirm the alias (or no API key is set), the calendar email is dropped, as such a message would be.
- From a real mailbox the rules of a message apply. A blocked calendar email is dropped, and a notification says why. Answer by email instead, or add an identity for the alias.
- The iCalendar part, the text and the identity's automatic Cc/Bcc are checked too.
- In "ask me" mode Thunderbird's question comes first, as without the add-on.
- If the add-on is enabled but its background page is not listening, calendar emails are not sent, and a message says so. A disabled add-on does not hook into anything.

Not covered: CalDAV servers that schedule themselves (for example Nextcloud, iCloud or Fastmail with server-side scheduling) send the invitation emails from the server, outside Thunderbird. Calendars of other add-ons (EWS, TbSync) are not covered either.

Read receipts need nothing: SimpleLogin removes the request header from every forwarded message, and Thunderbird asks before it sends a receipt.

### What the guard cannot see

- Other add-ons that send mail themselves, or that change a message after the check (their own onBeforeSend handlers run after it).
- Message filters that forward or reply with a template: they send without a compose window.
- A reverse alias on a domain the add-on has never seen a reverse alias on, sent once from a mailbox: it cannot tell that the message goes through SimpleLogin, so the checks for that way do not run.
- Binary attachments such as PDF or Office files, which may contain your address.
- References entries of messages that never went through SimpleLogin, in a thread that mixes direct and alias mail. SimpleLogin maps only the IDs it knows.

## Setup

1. Create an API key in the SimpleLogin dashboard under API Keys.
2. Open the add-on settings, paste the key and save. The test lists your protected mailboxes.
3. Choose the defaults for new aliases under Alias creation.
4. Thunderbird needs an identity for each of your mailboxes; the add-on creates the alias identities. Only mailboxes SimpleLogin lists as verified are used as senders.
5. If your mailbox identity has an OpenPGP key or S/MIME certificate, add a second identity with the same address and no keys. The add-on sends alias messages from that one. Calendar emails need a mailbox identity without automatic Cc/Bcc and Reply-To.

Creating reverse aliases needs a SimpleLogin plan that allows it.

### Permissions and data

- The API key is stored in Thunderbird's extension storage in plain text, like other add-ons store their tokens.
- Address books: to expand mailing lists among the recipients, and to keep reverse aliases in the address book "Alias Buddy".
- Messages: to read the message you reply to or forward (its recipients and Message-ID), and the sender and SimpleLogin header of a displayed message.
- Full access (Experiment API): for calendar emails, see above, and to show a newly created identity in open compose windows.
- Identities: to create the Thunderbird identity of an alias.
- Clipboard (write only): for Copy in the alias overview.
- SimpleLogin receives the addresses the add-on looks up: your identities, recipients that need a reverse alias, in a reply, a forward or a displayed message the alias SimpleLogin named in it, and for messages from a mailbox or an alias the sites of the recipients (to find their aliases).

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
