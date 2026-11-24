package com.waifucave.moss.phone.engine

import com.waifucave.moss.phone.model.*
import com.waifucave.moss.phonecore.ItemKind
import com.waifucave.moss.phonecore.SessionItem
import com.waifucave.moss.phonecore.AgentBackend as CBackend
import com.waifucave.moss.phonecore.AskQuestion as CQuestion
import com.waifucave.moss.phonecore.BackendOptions as COptions
import com.waifucave.moss.phonecore.Bot as CBot
import com.waifucave.moss.phonecore.BotFace as CFace
import com.waifucave.moss.phonecore.BotState as CBotState
import com.waifucave.moss.phonecore.BotSummary as CSummary
import com.waifucave.moss.phonecore.ComposerOffers as COffers
import com.waifucave.moss.phonecore.MessageFrom as CFrom
import com.waifucave.moss.phonecore.ModelsList as CModels
import com.waifucave.moss.phonecore.RecentStart as CRecent
import com.waifucave.moss.phonecore.SessionKind as CKind
import com.waifucave.moss.phonecore.SessionRow as CRow
import com.waifucave.moss.phonecore.SessionStatus as CStatus

/**
 * The core's typed records (`native/phone-core/src/engine.rs`, decoded once in Rust for both phones) as the screens'
 * models. Pure mapping, no JSON: a value the core reads as `Other` maps to its plainest meaning here.
 */
object Typed {
    fun face(f: CFace?): BotFaceSpec? = f?.let { BotFaceSpec(it.shape, it.color, it.eyes, it.temper) }

    fun state(s: CBotState?): BotState? = when (s) {
        is CBotState.Idle -> BotState.idle
        is CBotState.Thinking -> BotState.thinking
        is CBotState.Asleep -> BotState.asleep
        is CBotState.Paused -> BotState.paused
        else -> null
    }

    fun bot(b: CBot) = Bot(b.id, b.name, b.model, b.effort, face(b.face), state(b.state), b.computer, b.mainSession)

    fun summary(s: CSummary) = BotSummary(
        s.id,
        s.last?.let { l ->
            BotSummary.Last(l.text, when (l.from) { is CFrom.User -> BotSummary.From.user; is CFrom.Bot -> BotSummary.From.bot; else -> BotSummary.From.note }, l.at)
        },
        s.unread,
    )

    fun kind(k: CKind): String = when (k) {
        is CKind.Bot -> "bot"
        is CKind.SideThread -> "side-thread"
        is CKind.Agent -> "agent"
        is CKind.Coding -> "coding"
        is CKind.Other -> k.value
    }

    fun status(s: CStatus): SessionStatus = when (s) {
        is CStatus.Starting -> SessionStatus.starting
        is CStatus.Ready -> SessionStatus.ready
        is CStatus.Prompting -> SessionStatus.prompting
        is CStatus.Cancelling -> SessionStatus.cancelling
        is CStatus.Idle -> SessionStatus.idle
        is CStatus.Stopped -> SessionStatus.stopped
        is CStatus.Failed -> SessionStatus.failed
        else -> SessionStatus.idle
    }

    fun session(r: CRow) = SessionRow(
        id = r.id, kind = kind(r.kind), bot = r.bot, parent = r.parent, computer = r.computer, title = r.title, status = status(r.status),
        startedAt = r.startedAt, updatedAt = r.updatedAt, backend = r.backend, model = r.model, root = r.root, branch = r.branch,
        changes = r.changes?.toInt(), needsYou = r.needsYou?.let { NeedsYou(it.cards.toInt(), it.questions.toInt()) },
        waiting = r.waiting?.let { SessionWaiting(it.tasks.toInt(), it.children.toInt()) }, archived = r.archived,
    )

    /**
     * One item of a session's log as a conversation shows it, or `null` for what it doesn't show. A bot's replies are the
     * bot's, a coding session's the agent's; `deviceName` names another device a user message came from (`null`: this phone).
     */
    fun message(i: SessionItem, bot: Boolean, deviceName: (String) -> String?): ChatMessage? {
        fun note(t: String) = t.takeIf { it.isNotBlank() }?.let { ChatMessage(i.id, MessageRole.note, it, i.at) }
        return when (val k = i.kind) {
            is ItemKind.User -> ChatMessage(i.id, MessageRole.user, k.text, i.at, device = k.device?.let(deviceName))
            is ItemKind.Assistant -> k.text.takeIf { it.isNotEmpty() }?.let { ChatMessage(i.id, if (bot) MessageRole.bot else MessageRole.agent, it, i.at) }
            is ItemKind.Agent -> ChatMessage(i.id, MessageRole.agent, k.text, i.at)
            is ItemKind.FromBot -> note(k.text)
            is ItemKind.FromSession -> note(k.text)
            is ItemKind.FromPlugin -> note(k.text)
            is ItemKind.Routine -> note(listOfNotNull(k.name, k.text).joinToString(": "))
            is ItemKind.Note -> note(listOfNotNull(k.label?.takeIf { it.isNotBlank() }, k.text).joinToString(": "))
            is ItemKind.TurnError -> note("Something went wrong: ${k.text}")
            is ItemKind.TurnEnded -> if (k.reason == "aborted") note("Interrupted") else null
            else -> null
        }
    }

    /** The core's question as the screens' (the first of its questions: the phone asks one at a time). */
    fun question(q: CQuestion?): AskQuestion? {
        val first = q?.questions?.firstOrNull() ?: return null
        return AskQuestion(q.callId, first.header, first.question, first.options.map { AskQuestion.Option(it.label, it.description) }, first.multiSelect)
    }

    /** A backend a person can start here: user-startable and installed on the computer this phone is linked to. */
    fun backend(b: CBackend, computer: String?): AgentBackend? {
        if (!b.userStartable) return null
        if (computer != null && b.computers.isNotEmpty() && b.computers.none { it.computer == computer && it.installed }) return null
        return AgentBackend(b.id, b.name)
    }

    fun options(o: COptions) = BackendOptions(
        o.backend, o.known, o.models.map { ModelOption(it.id, it.name, it.efforts, it.defaultEffort) }, o.defaultModel, o.defaultEffort,
    )

    fun recent(r: CRecent) = RecentStart(
        r.last?.let { RecentStart.Choice(it.backend, it.model, it.effort) },
        r.byBackend.map { RecentStart.Choice(it.backend, it.model, it.effort) },
        r.roots.sortedByDescending { it.at }.map { it.root },
    )

    fun offers(o: COffers) = ComposerOffers(
        pictures = o.pictures,
        commands = o.commands.map { PluginCommand(it.name, it.description) },
        efforts = o.efforts, effort = o.effort,
        models = o.models.map { ModelChoice(it.id, it.name, it.efforts) }, model = o.model,
        files = o.files != null, fileLimit = o.files?.maxBytes, fileCount = o.files?.perMessage?.toInt(),
    )

    /** The signed-in models a session (or a new bot) may use. */
    fun choices(m: CModels): List<ModelChoice> = m.models.filter { it.signedIn }.map { ModelChoice(it.id, it.name, it.efforts) }

    fun newBot(m: CModels): NewBotOptions {
        val c = choices(m)
        return NewBotOptions(c, m.defaultModel?.takeIf { d -> c.any { it.id == d } })
    }
}
