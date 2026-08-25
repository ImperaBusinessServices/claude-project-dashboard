This release covers everything built since 2.12.2.

## Local AI answers in seconds again, not minutes

Most AI models you download to your own computer think to themselves before answering — they write out a long private train of thought first, and you see nothing on screen while they do it. On a modest computer that turns a two-second reply into a several-minute one, and sometimes the thinking uses up the whole reply so nothing at all comes back.

**Launch Local AI** now switches that off. On the machine this was built on, the same question went from **21 seconds and a blank answer** to **under a second and a proper one**.

If you have a powerful graphics card and want the thinking — it does make hard questions better — there's a new switch for it under **Settings → Local AI**.

## Launch Claude on your company's AWS Bedrock

If your employer runs Claude through their own AWS account, that's now one of the AIs you can launch. It is the same Claude Code; only the connection changes, so messages are billed to the company instead of your personal plan. Your personal **Launch Claude** is untouched.

Switch it on under **Settings → Which AI runs when you click Launch**, then pick it from any project's **▾** menu. That project remembers it. Bedrock projects get an orange Launch button and an orange terminal tab, so work and personal are never confused at a glance.

It needs a one-off setup on your computer first — Claude Code, the AWS CLI, and credentials from your AWS admin. If it isn't ready, the app says so and lists what's missing.

## Usage meters for Codex and Kimi

The Claude usage bars in the header now have company. If you use Codex CLI, a blue-edged meter shows your Codex plan usage — the same numbers as Codex's own `/status` screen, with the countdown to when the limit resets. If you've bought prepaid Kimi (Moonshot) credit, a green-edged meter shows how many dollars you have left.

Each meter appears only when that tool is signed in on your computer. If you only use Claude, nothing changes.

## Spend counts paid AIs other than Claude

If you run a paid model through OpenCode on your own API key, that money used to be invisible here, because Spend only read Claude's logs. It now also reads the record OpenCode keeps of its own sessions, so those models appear alongside Claude in the chart and in both breakdown tables.

The cost comes from OpenCode's own figures rather than a guess. Free and local models aren't listed — they cost nothing. Your provider's billing page is still the last word on what you actually owe.

---

## Installing

**Windows** — download `Claude Project Dashboard Setup 2.16.0.exe` and double-click it. Windows will show a blue "Windows protected your PC" box because the installer isn't code-signed: click **More info**, then **Run anyway**. That's expected. No admin password needed.

**Mac** — download the `.dmg`, open it, and drag the app to Applications. It's Apple-signed and notarised, so it opens with no warnings.

Already have it installed? Open **Settings → Check for updates**.
