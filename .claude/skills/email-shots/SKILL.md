---
name: email-shots
description: Email screenshots, renders, or any files to Jacek (jacek.becela@gmail.com) via automat's Gmail SMTP. Use when the user asks to send images/files to their email.
---

# Email screenshots / files

Send files as email attachments using the SMTP account of the `~/dev/automat`
Rails app (Gmail, sender `brix@trix.pl`). Default recipient is
`jacek.becela@gmail.com`.

## How

Run the bundled script (it can run from any directory — credential paths are
absolute):

```bash
ruby .claude/skills/email-shots/scripts/send_files.rb \
  -s "subject line" \
  -b "plain-text body describing the attachments" \
  path/to/shot1.png path/to/shot2.png
```

Flags: `-s` subject, `-b` body, `-t` alternate recipient. Everything else is
attachment paths. On success it prints `sent N attachment(s) to <addr>`.

## Prerequisites

- Gems: `gem install mail activesupport --no-document` (one-time per Ruby
  version). Do NOT try `bundle exec` in automat — its bundle is containerized
  and not installed locally.
- `~/dev/automat/config/master.key` + `config/credentials.yml.enc` must exist
  (they decrypt the SMTP password).

## Security — non-negotiable

The SMTP password is decrypted **in-process** by the script and used only for
SMTP auth. NEVER print, echo, grep, or dump decrypted Rails credentials
(`bin/rails credentials:show` etc.) into the conversation or logs. If the
script needs another secret, read it inside the script the same way.

## Tips

- A benign `Non US-ASCII detected ... Defaulting to UTF-8` warning from the
  mail gem is normal when the body has non-ASCII characters.
- Write a body that says what each attachment shows — the user reads this on
  their phone away from the session.
