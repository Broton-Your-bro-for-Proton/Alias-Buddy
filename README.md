# Alias Buddy for SimpleLogin

A Thunderbird add-on that lets you send as a [SimpleLogin](https://simplelogin.io) alias to normal addresses. It creates and fills in the reverse aliases for you, and it blocks messages that would reveal your real address.

Not affiliated with or endorsed by Proton AG or SimpleLogin.

## How it works

SimpleLogin only sends as an alias when the message comes from one of your mailboxes and goes to a reverse alias of that alias. The add-on does this at the moment you press Send:

1. You pick the alias as sender (a Thunderbird identity with the alias address) and write to the real address of your contact.
2. The add-on looks up the alias, creates the contact through the SimpleLogin API if needed, and replaces every recipient with its reverse alias.
3. It switches the sender to the Thunderbird identity of the alias's mailbox, because SimpleLogin only accepts it from there.
4. It checks the final state before the message leaves: sender, recipients, Reply-To, vCard, OpenPGP key, signing and the text. Anything that would reveal your mailbox address stops the send.

Your contact sees your alias as sender and their own address as recipient. Your Sent folder keeps the reverse aliases and your mailbox address, as that is what went out.

The toolbar button in the compose window shows what will happen to each recipient.

## The guard

Every send goes through the guard:

- **From a real mailbox** (your SimpleLogin mailboxes and any address you add in the settings): only reverse aliases and allowlisted addresses are accepted. Mixing both is blocked too, because SimpleLogin drops such messages.
- **As an alias**: the message is rewritten as above. A reverse alias that belongs to another alias, your real address in the text, or a failed final check blocks it.
- **Other identities** are left alone once SimpleLogin confirmed they are not aliases.
- **SimpleLogin unreachable**: answers from the last 10 minutes are used. Without them the send is blocked.

A blocked message stays open. Where it is safe, the toolbar popup offers to send it once unchanged.

### What the guard cannot see

- Read receipts that Thunderbird sends automatically. Turn them off under Settings > Privacy & Security, or per account.
- Replies to calendar invitations, which do not go through the compose window.
- Other add-ons that send mail themselves.

## Setup

1. Create an API key in the SimpleLogin dashboard under API Keys.
2. Open the add-on settings, paste the key and save. The test lists your protected mailboxes.
3. Add a Thunderbird identity for each alias you want to send as (Account Settings > Manage Identities), in the account whose identity uses the alias's mailbox.

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
