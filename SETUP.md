# Butterbase Setup

Connects this project to Butterbase (the AI-backend platform, not the bakery app) via MCP, so
Claude Code can create the app, define the schema, and wire up auth/storage/functions directly.

Put `.mcp.json` at the root of this project folder — it's inert until the two steps below are
done. It reads the API key from an environment variable, never from the file itself.

## Steps that only you can do

### 1. Create a Butterbase account
Go to dashboard.butterbase.ai and sign up.

### 2. Generate an API key
In the dashboard, open the API Keys page and generate a service key. It will look like
`bb_sk_...`. Copy it.

### 3. Set it as an environment variable

PowerShell (current session only — good enough to test):
    $env:BUTTERBASE_API_KEY = "bb_sk_your_key_here"

PowerShell (persistent — survives new terminals/reboots):
    setx BUTTERBASE_API_KEY "bb_sk_your_key_here"

Note: setx only takes effect in new terminal windows opened after running it — restart
VS Code / your terminal afterward.

Do not paste the key into any file in this repo, including .mcp.json — it's designed to pull
the value from the environment, not store it.

### 4. Reload so the MCP connection picks up
Restart Claude Code (or reload the VS Code window if you're using the extension there) so it
re-reads .mcp.json and connects using the now-set environment variable.

## Verify it worked

Once reloaded, just ask in chat: "list your Butterbase tools" or "check the Butterbase
connection." If it's wired up correctly, Claude Code will have access to app/schema/auth/
storage/function management tools directly — no further setup needed.

## After that

Come back and say "let's build the schema" — the README.md decision log has the
categorization/reconciliation data model (clients, transactions, channel payouts, vendor
rules) ready to translate into a Butterbase schema.