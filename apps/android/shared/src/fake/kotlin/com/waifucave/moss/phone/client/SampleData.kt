package com.waifucave.moss.phone.client

import com.waifucave.moss.phone.model.*

/** Sample data shaped like the engine's payloads: the iPhone fake's, value for value. Not real people, bots or paths. */
object SampleData {
    /** A fixed "now" (2026-11-24 10:00 UTC) so pictures and tests never depend on the clock. */
    const val now: Long = 1_795_600_800_000
    fun ago(seconds: Long): Long = now - seconds * 1000

    const val computerName = "Studio"
    const val phoneName = "Phone"

    val bots: List<Bot> = listOf(
        Bot("alpha", "Alpha", model = "fireworks/kimi-k3", effort = "medium", face = BotFaceSpec(color = "coral"), state = BotState.idle, computer = computerName, mainSession = "s_alpha"),
        Bot("luna", "Luna", model = "anthropic/claude-sonnet", state = BotState.thinking, computer = computerName, mainSession = "s_luna"),
        Bot("juniper", "Juniper", model = "openai/gpt-5", state = BotState.idle, computer = computerName, mainSession = "s_juniper"),
        Bot("pip", "Pip", face = BotFaceSpec(shape = "drop", color = "sky"), state = BotState.idle, computer = computerName, mainSession = "s_pip"),
        Bot("marlow", "Marlow", state = BotState.asleep, mainSession = "s_marlow"),
        Bot("sorrel", "Sorrel", state = BotState.paused, computer = computerName, mainSession = "s_sorrel"),
        Bot("tansy", "Tansy", state = BotState.idle, computer = computerName, mainSession = "s_tansy"),
        Bot("ember", "Ember", state = BotState.idle, computer = computerName, mainSession = "s_ember"),
        Bot("wren", "Wren", state = BotState.idle, computer = computerName, mainSession = "s_wren"),
        Bot("fig", "Fig", state = BotState.idle, computer = computerName, mainSession = "s_fig"),
        Bot("briar", "Briar", state = BotState.idle, computer = computerName, mainSession = "s_briar"),
    )

    private fun last(text: String, from: BotSummary.From, at: Long) = BotSummary.Last(text, from, at)
    val summaries: List<BotSummary> = listOf(
        BotSummary("alpha", last("The deploy finished. Nothing needed a retry.", BotSummary.From.bot, ago(240)), unread = true),
        BotSummary("luna", last("Looking through this week's receipts", BotSummary.From.note, ago(30)), unread = false),
        BotSummary("juniper", last("Thanks, that is the one I wanted.", BotSummary.From.user, ago(3 * 3600)), unread = false),
        BotSummary("pip", last("Your 3 pm is moved to Thursday.", BotSummary.From.bot, ago(26 * 3600)), unread = true),
        BotSummary("marlow", last("I will pick this up when Studio is on.", BotSummary.From.bot, ago(3 * 86400)), unread = false),
        BotSummary("sorrel", null, unread = false),
        BotSummary("tansy", last("Booked the table for four.", BotSummary.From.bot, ago(5 * 86400)), unread = false),
        BotSummary("ember", last("Outreach drafts queued for approval.", BotSummary.From.bot, ago(2 * 3600)), unread = true),
        BotSummary("wren", last("The weekly numbers are in the sheet.", BotSummary.From.bot, ago(4 * 86400)), unread = false),
        BotSummary("fig", last("I moved the invoices to the shared folder.", BotSummary.From.bot, ago(6 * 86400)), unread = false),
        BotSummary("briar", last("Nothing new in the inbox since Friday.", BotSummary.From.bot, ago(9 * 86400)), unread = false),
    )

    /** The bots the person pinned: the phone keeps this itself (the engine has no such field). */
    val pinned: List<String> = listOf("luna", "juniper", "tansy")

    fun conversation(bot: String): List<ChatMessage> = when (bot) {
        "alpha" -> listOf(
            ChatMessage("m1", MessageRole.user, "Can you ship the docs fix tonight?", ago(3900)),
            ChatMessage("m2", MessageRole.bot, "Yes. I will run the checks first and tell you when it is out.", ago(3880)),
            ChatMessage("m3", MessageRole.note, "Ran the checks on Studio", ago(3000)),
            ChatMessage("m4", MessageRole.bot, "The deploy finished. Nothing needed a retry.", ago(240)),
            ChatMessage("m5", MessageRole.user, "Great. Anything waiting on me?", ago(200), device = "Laptop"),
            ChatMessage("m6", MessageRole.bot, "One approval is waiting: I would like to clear the old build folder.", ago(150)),
            ChatMessage("m7", MessageRole.bot, "The release notes are written up at https://example.com/notes", ago(140)),
            ChatMessage("m8", MessageRole.bot, "", ago(130), file = ChatFile("Release notes.pdf", "12 pages · 1.2 MB")),
        )
        else -> {
            val name = bots.firstOrNull { it.id == bot }?.name ?: "Bot"
            listOf(ChatMessage("$bot-1", MessageRole.bot, "Hello, I am $name. What would you like to do?", ago(86400)))
        }
    }

    // Sessions, shaped as `session.list` serves them; root is `home/<Computer>/<project>`.
    val sessions: List<SessionRow> = listOf(
        SessionRow("c1", computer = computerName, title = "Fix the flaky pairing test", status = SessionStatus.prompting, startedAt = ago(1800), updatedAt = ago(20),
            backend = "claude-code", model = "claude-opus", root = "home/Studio/moss", branch = "lane/pairing", changes = 4),
        SessionRow("c2", computer = computerName, title = "Move the settings page to the new form", status = SessionStatus.idle, startedAt = ago(9000), updatedAt = ago(600),
            backend = "moss-code", model = "kimi-k3", root = "home/Studio/moss", branch = "settings-form", changes = 12, needsYou = NeedsYou(1, 0)),
        SessionRow("c3", computer = computerName, title = "Read the failing CI log", status = SessionStatus.idle, startedAt = ago(20000), updatedAt = ago(4000),
            backend = "codex", model = "gpt-5-codex", root = "home/Studio/moss", waiting = SessionWaiting(1, 0)),
        SessionRow("c4", computer = computerName, title = "Which colour for the new tag?", status = SessionStatus.idle, startedAt = ago(30000), updatedAt = ago(7200),
            backend = "claude-code", model = "claude-sonnet", root = "home/Studio/website", needsYou = NeedsYou(0, 1)),
        SessionRow("c5", computer = computerName, title = "Rebuild the landing page header", status = SessionStatus.idle, startedAt = ago(90000), updatedAt = ago(30000),
            backend = "gemini", model = "gemini-pro", root = "home/Studio/website", branch = "header", changes = 0),
        SessionRow("c6", computer = computerName, title = "Trim the install script", status = SessionStatus.stopped, startedAt = ago(200000), updatedAt = ago(100000),
            backend = "opencode", model = "kimi-k3", root = "home/Studio/tools"),
        SessionRow("c7", computer = computerName, title = "Notes from the review", status = SessionStatus.failed, startedAt = ago(300000), updatedAt = ago(250000),
            backend = "cursor", model = "auto", root = "home/Studio/tools"),
    )

    /** Questions waiting in a conversation, by session id. */
    /** A question as tall as a computer may send: ten lines, with tabs, and an option whose preview runs long. */
    val tallQuestion = AskQuestion("ask_tall", header = "Release", text = (1..10).joinToString("\n") { "Line $it of the question:\tthe computer's own words, kept as sent." },
        options = listOf(
            AskQuestion.Option("Ship it", "Build, sign and upload\nthe release now", preview = (1..30).joinToString("\n") { "step $it:\trun the release task number $it" }),
            AskQuestion.Option("Wait", "Keep it for tomorrow")))
    val questions: Map<String, AskQuestion> = mapOf(
        "c4" to AskQuestion("ask_1", header = "Tag colour", text = "Which colour should the new tag have?", options = listOf(
            AskQuestion.Option("Green", "Matches the success states"), AskQuestion.Option("Amber", "Stands out on the white page"),
            AskQuestion.Option("Grey", "Quiet, like the other tags"))),
        "s_luna" to AskQuestion("ask_2", header = "Receipts", text = "Which folder should I keep this week's receipts in?", options = listOf(
            AskQuestion.Option("Receipts 2026"), AskQuestion.Option("Taxes"), AskQuestion.Option("A new folder"))),
    )

    fun sessionMessages(id: String): List<ChatMessage> = when (id) {
        "c1" -> listOf(
            ChatMessage("c1-1", MessageRole.user, "The pairing test fails about one run in five. Find out why.", ago(1790)),
            ChatMessage("c1-2", MessageRole.agent, "The test waits a fixed 200 ms for the words to arrive. On a busy runner they come later. I will wait for the event instead.", ago(1500)),
            ChatMessage("c1-3", MessageRole.note, "Edited pairing.test.ts", ago(900)),
            ChatMessage("c1-4", MessageRole.agent, "Fixed in the test; running it fifty times now.", ago(120)),
        )
        "c2" -> listOf(
            ChatMessage("c2-a", MessageRole.user, "Which settings pages still use the old form?", ago(20000)),
            ChatMessage("c2-b", MessageRole.agent, "Four of them: profile, billing, notifications and the API keys page.", ago(19500)),
            ChatMessage("c2-c", MessageRole.user, "Move them one by one and run the tests after each.", ago(19000)),
            ChatMessage("c2-d", MessageRole.agent, "Starting with profile. I will keep the old component until all four are done.", ago(18500)),
            ChatMessage("c2-1", MessageRole.user, "Move the settings page to the new form component.", ago(8900)),
            ChatMessage("c2-2", MessageRole.agent, "Done in 12 files. I want to delete the old form folder, which needs your approval.", ago(700)),
        )
        else -> listOf(ChatMessage("$id-1", MessageRole.agent, "Ready when you are.", ago(5000)))
    }

    /** The engine's provider-consent card (`bots/provider-consent.ts`): the provider whose key gets used is only in `host`. */
    val providerConsentCard = Card("card_9c8b7a6f", "change", computer = computerName, bot = "luna", origin = "user",
        issuedAt = ago(30), expiresAt = Long.MAX_VALUE, hash = "c".repeat(64),
        fields = linkedMapOf(
            "title" to SealedValue.Text("Let this bot use a provider its plugin chose?"),
            "what" to SealedValue.Text("This bot's plugin, not you, chose a model whose provider uses your stored key. A yes lets this bot use that provider with your key, and no other bot or provider."),
            "reason" to SealedValue.Text("You can choose the model yourself in the bot's settings instead: then nothing asks."),
            "source" to SealedValue.Code("luna"),
            "host" to SealedValue.Code("fireworks"),
            "command" to SealedValue.Code("fireworks/kimi-k3"),
        ),
        options = listOf(CardOption("deny", CardOption.Kind.deny, "No"), CardOption("approve", CardOption.Kind.approve, "Yes")),
    )

    /** A card whose values overflow their area: a 6-line command and detail, 8 paths, the site, and the rule last. */
    val tallCard = Card("card_7d6e5f4a", "tool", computer = computerName, bot = "luna", origin = "user",
        issuedAt = ago(20), expiresAt = Long.MAX_VALUE, hash = "d".repeat(64),
        fields = linkedMapOf(
            "title" to SealedValue.Text("Run a cleanup script?"),
            "what" to SealedValue.Text("Luna wants to tidy the build folders."),
            "command" to SealedValue.Code((1..6).joinToString("\n") { "rm -rf packages/app$it/dist" }, "sh"),
            "detail" to SealedValue.Code((1..6).joinToString("\n") { "step $it of 6" }),
            "paths" to SealedValue.ListOf((1..8).map { "packages/app$it/dist/" }),
            "host" to SealedValue.Code("registry.example.com"),
            "rule" to SealedValue.Rows(listOf(SealedValue.Row("What", "this exact command"), SealedValue.Row("Where", "any folder, on Studio only"))),
        ),
        options = listOf(
            CardOption("deny", CardOption.Kind.deny, "Deny"),
            CardOption("allow_always", CardOption.Kind.approve, "Always allow", rememberAlways = true),
            CardOption("allow_once", CardOption.Kind.approve, "Allow"),
        ),
    )

    val cards: List<Card> = listOf(
        Card("card_0a1b2c3d", "tool", computer = computerName, session = "s_alpha", bot = "alpha", origin = "routine",
            issuedAt = ago(150), expiresAt = now + 450_000, hash = "a".repeat(64),
            fields = linkedMapOf(
                "title" to SealedValue.Text("Run a command?"),
                "what" to SealedValue.Text("Alpha wants to clear the old build folder."),
                "command" to SealedValue.Code("rm -rf build/", "sh"),
                "computer" to SealedValue.Text(computerName),
                "risk" to SealedValue.Text("Deletes a folder"),
            ),
            options = listOf(
                CardOption("allow_once", CardOption.Kind.approve, "Allow"),
                CardOption("allow_always", CardOption.Kind.approve, "Always allow", rememberAlways = true),
                CardOption("deny", CardOption.Kind.deny, "Deny"),
            )),
        Card("card_9f8e7d6c", "tool", computer = computerName, session = "c2", origin = "agent",
            issuedAt = ago(600), expiresAt = now + 900_000, hash = "b".repeat(64),
            fields = linkedMapOf(
                "title" to SealedValue.Text("Delete a folder?"),
                "what" to SealedValue.Text("MOSS Code wants to remove the old form folder from the project."),
                "paths" to SealedValue.ListOf(listOf("src/settings/old-form/", "src/settings/old-form.test.ts")),
                "computer" to SealedValue.Text(computerName),
                "reason" to SealedValue.Text("The settings page no longer uses it."),
            ),
            options = listOf(
                CardOption("allow_once", CardOption.Kind.approve, "Allow"),
                CardOption("deny", CardOption.Kind.deny, "Deny"),
            )),
        Card("card_55aa66bb", "tool", computer = computerName, session = "s_pip", bot = "pip", origin = "bot",
            issuedAt = ago(90), expiresAt = now + 800_000, hash = "c".repeat(64),
            fields = linkedMapOf(
                "title" to SealedValue.Text("Send an email?"),
                "what" to SealedValue.Text("Pip wants to send the moved invitation."),
                "detail" to SealedValue.Rows(listOf(SealedValue.Row("To", "the book club"), SealedValue.Row("Subject", "Thursday instead"))),
                "computer" to SealedValue.Text(computerName),
            ),
            options = listOf(
                CardOption("allow_once", CardOption.Kind.approve, "Send"),
                CardOption("deny", CardOption.Kind.deny, "Don't send"),
            )),
    )

    val backends: List<AgentBackend> = listOf(
        AgentBackend("moss-code", "MOSS Code"), AgentBackend("claude-code", "Claude Code"),
        AgentBackend("codex", "Codex"), AgentBackend("gemini", "Gemini"), AgentBackend("opencode", "OpenCode"),
    )

    fun options(backend: String): BackendOptions = when (backend) {
        "claude-code" -> BackendOptions(backend, models = listOf(
            ModelOption("claude-opus", "Opus", listOf("low", "medium", "high"), "high"),
            ModelOption("claude-sonnet", "Sonnet", listOf("low", "medium", "high"), "medium"),
        ), defaultModel = "claude-opus", defaultEffort = "high")
        "codex" -> BackendOptions(backend, models = listOf(ModelOption("gpt-5-codex", "GPT-5 Codex", listOf("low", "medium", "high"), "medium")),
            defaultModel = "gpt-5-codex", defaultEffort = "medium")
        "moss-code" -> BackendOptions(backend, models = listOf(ModelOption("kimi-k3", "Kimi K3", listOf("medium", "high"), "medium"),
            ModelOption("gpt-5", "GPT-5", listOf("low", "medium", "high"), "medium")), defaultModel = "kimi-k3", defaultEffort = "medium")
        // An agent whose models are unknown until it starts.
        else -> BackendOptions(backend, known = false, models = emptyList())
    }

    val recentStart = RecentStart(
        last = RecentStart.Choice("claude-code", "claude-sonnet", "medium"),
        byBackend = listOf(RecentStart.Choice("claude-code", "claude-sonnet", "medium"), RecentStart.Choice("codex", "gpt-5-codex", "high")),
        roots = listOf("home/Studio/moss", "home/Studio/website", "home/Studio/tools"),
    )
}
