#!/usr/bin/env ruby
# Email files (screenshots, renders, reports) via automat's Gmail SMTP account
# (brix@trix.pl). The SMTP password is decrypted from automat's encrypted Rails
# credentials IN-PROCESS and must never be printed or logged.
#
# Usage:
#   ruby send_files.rb [-s subject] [-b body] [-t to@addr] <file...>
#
# Prerequisites: `gem install mail activesupport --no-document` (no bundler —
# automat's bundle is containerized and not installed locally).
require "optparse"
require "active_support"
require "active_support/encrypted_configuration"
require "mail"

AUTOMAT = File.expand_path("~/dev/automat")
to = "jacek.becela@gmail.com"
subject = "files from Claude Code"
body = "Sent by Claude Code via the email-shots skill."
OptionParser.new do |o|
  o.on("-s SUBJECT") { |v| subject = v }
  o.on("-b BODY") { |v| body = v }
  o.on("-t TO") { |v| to = v }
end.parse!
files = ARGV
abort("usage: send_files.rb [-s subject] [-b body] [-t to] <file...>") if files.empty?
files.each { |f| abort("no such file: #{f}") unless File.exist?(f) }

creds = ActiveSupport::EncryptedConfiguration.new(
  config_path: File.join(AUTOMAT, "config/credentials.yml.enc"),
  key_path: File.join(AUTOMAT, "config/master.key"),
  env_key: "RAILS_MASTER_KEY",
  raise_if_missing_key: true
)
password = creds.smtp_password
abort("no smtp_password in automat credentials") if password.to_s.empty?

Mail.defaults do
  delivery_method :smtp, {
    address: "smtp.gmail.com",
    port: 587,
    user_name: "brix@trix.pl",
    password: password,
    authentication: "plain",
    enable_starttls_auto: true
  }
end

m = Mail.new
m.from "brix@trix.pl"
m.to to
m.subject subject
m.body body
files.each { |f| m.add_file(f) }
m.deliver!
puts "sent #{files.length} attachment(s) to #{to}"
