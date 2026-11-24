package com.waifucave.moss.phone.vm

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.waifucave.moss.phone.client.EngineClient
import com.waifucave.moss.phone.model.*
import kotlinx.coroutines.CancellationException

/**
 * Starting a coding session from the phone: the agent (the last used preselected), its model and effort (defaults
 * preselected) and the folder (folders of existing sessions first, or any path typed or pasted).
 */
class NewSessionModel(private val client: EngineClient, private val computer: String) {
    var backends by mutableStateOf<List<AgentBackend>>(emptyList())
        private set
    var options by mutableStateOf<BackendOptions?>(null)
        private set
    var folders by mutableStateOf<List<String>>(emptyList())
        private set
    var loading by mutableStateOf(true)
        private set
    var loadFailed by mutableStateOf(false)
        private set
    var errorText by mutableStateOf<String?>(null)
        private set
    var starting by mutableStateOf(false)
        private set
    var backend by mutableStateOf("")
        private set
    var model by mutableStateOf<String?>(null)
        private set
    var effort by mutableStateOf<String?>(null)
    /** The folder the person typed or pasted; when empty, `pickedFolder` is used. */
    var typedFolder by mutableStateOf("")
    var pickedFolder by mutableStateOf<String?>(null)

    private var recent = RecentStart()

    val folder: String get() = typedFolder.trim().ifEmpty { pickedFolder ?: "" }
    val canStart: Boolean get() = backend.isNotEmpty() && folder.isNotEmpty() && !starting && !loading
    val efforts: List<String> get() = options?.models?.firstOrNull { it.id == model }?.efforts ?: emptyList()
    val modelChoices: List<ModelOption> get() = options?.models ?: emptyList()

    suspend fun load() {
        loading = true
        try {
            val all = client.backends()
            recent = client.recentStart()
            backends = all
            folders = recent.roots
            pickedFolder = recent.roots.firstOrNull()
            // The last used agent, else the first one.
            val start = recent.last?.backend?.takeIf { b -> all.any { it.id == b } } ?: all.firstOrNull()?.id ?: ""
            loadFailed = false
            backend = start
            if (start.isNotEmpty()) loadOptions()
        } catch (e: CancellationException) { throw e } catch (e: Exception) { loadFailed = true }
        loading = false
    }

    /** The person picked another agent: its options load and its last model and effort are preselected. */
    suspend fun chooseBackend(id: String) {
        if (id == backend || id.isEmpty()) return
        backend = id
        loadOptions()
    }

    /** The person picked a model: its effort stays if the model has it, else the model's default. */
    fun chooseModel(id: String?) {
        model = id
        applyEffortDefault()
    }

    private suspend fun loadOptions() {
        try {
            val o = client.startOptions(backend)
            options = o
            val mine = recent.byBackend.firstOrNull { it.backend == backend }
            model = mine?.model?.takeIf { m -> o.models.any { it.id == m } } ?: o.defaultModel ?: o.models.firstOrNull()?.id
            val candidate = mine?.effort ?: o.defaultEffort
            effort = candidate?.takeIf { it in efforts } ?: o.models.firstOrNull { it.id == model }?.defaultEffort
        } catch (e: CancellationException) { throw e } catch (e: Exception) { options = null; model = null; effort = null }
    }

    private fun applyEffortDefault() {
        val m = options?.models?.firstOrNull { it.id == model } ?: return
        val e = effort
        if (e != null && e in m.efforts) return
        effort = m.defaultEffort ?: m.efforts.firstOrNull()
    }

    /** Starts it; returns the new session's id, or null with `errorText` set. */
    suspend fun start(): String? {
        if (!canStart) return null
        starting = true
        try {
            val id = client.startSession(StartRequest(backend, computer, folder, model, effort))
            errorText = null
            return id
        } catch (e: StartException) {
            errorText = when (e.error) {
                StartError.folderRefused -> "That folder can't be used. Pick a folder of your computer's, not MOSS's own."
                StartError.notInstalled -> "That agent isn't installed on $computer."
            }
        } catch (e: CancellationException) { throw e } catch (e: Exception) {
            errorText = "Can't reach your computer. Nothing was started."
        } finally { starting = false }
        return null
    }
}

/** The first-run pairing: scan the code on the computer, show the four words, confirm. */
class PairingModel(private val client: EngineClient, step: Step = Step.Scanning) {
    sealed class Step {
        data object Scanning : Step()
        data object Checking : Step()
        data class Confirming(val proposal: PairingProposal) : Step()
        data class Paired(val computer: PairedComputer) : Step()
        data class Failed(val error: PairingError) : Step()
    }
    var step by mutableStateOf(step)
        private set

    suspend fun scanned(code: String) {
        if (step != Step.Scanning) return
        step = Step.Checking
        step = try { Step.Confirming(client.beginPairing(code)) }
        catch (e: PairingException) { Step.Failed(e.error) }
        catch (e: CancellationException) { throw e } catch (e: Exception) { Step.Failed(PairingError.unreachable) }
    }

    /** The person says the four words match what the computer shows. */
    suspend fun confirm() {
        val s = step as? Step.Confirming ?: return
        step = try { Step.Paired(client.confirmPairing(s.proposal)) }
        catch (e: PairingException) { Step.Failed(e.error) }
        catch (e: CancellationException) { throw e } catch (e: Exception) { Step.Failed(PairingError.unreachable) }
    }

    /** The words do not match, or the person backs out. */
    suspend fun cancel() {
        (step as? Step.Confirming)?.let { client.cancelPairing(it.proposal) }
        step = Step.Scanning
    }
    fun retry() { step = Step.Scanning }
}

val PairingError.message: String
    get() = when (this) {
        PairingError.unreadableCode -> "That isn't a MOSS pairing code. Scan the code your computer shows."
        PairingError.expired -> "That code has expired. Show a new one on your computer."
        PairingError.wordsDoNotMatch -> "The words didn't match, so nothing was paired."
        PairingError.unreachable -> "Can't reach your computer. Is it on and nearby?"
    }

/** The Settings screen: the paired computer, Unpair behind a confirmation, and the app's version. */
class SettingsModel(private val client: EngineClient, val version: String) {
    var computer by mutableStateOf<PairedComputer?>(null)
        private set
    var connection by mutableStateOf<ConnectionState>(ConnectionState.Connected)
        private set
    var confirmingUnpair by mutableStateOf(false)

    suspend fun load() {
        computer = client.pairedComputer()
        connection = client.connectionState()
    }

    /** "Connected now", "Last seen 2 hours ago": when the link last carried anything. */
    fun lastSeenText(now: Long): String {
        val c = connection
        if (c is ConnectionState.Connected) return "Connected now"
        val at = (c as ConnectionState.Unreachable).since ?: computer?.lastSeen ?: return "Not reachable now"
        return "Last seen ${com.waifucave.moss.phone.ui.TimeText.relative(at, now)}"
    }

    /** The person confirmed. Forgets this computer; the app goes back to the pairing screen. */
    suspend fun unpair() {
        client.unpair()
        computer = null
        confirmingUnpair = false
    }
}

/** The new-bot sheet: a name, and a model with the computer's default preselected. */
class NewBotModel(private val client: EngineClient) {
    var name by mutableStateOf("")
    var model by mutableStateOf<String?>(null)
    var options by mutableStateOf<NewBotOptions?>(null)
        private set
    var loading by mutableStateOf(true)
        private set
    var errorText by mutableStateOf<String?>(null)
        private set
    var creating by mutableStateOf(false)
        private set

    val canCreate: Boolean get() = name.isNotBlank() && !creating

    suspend fun load() {
        loading = true
        try {
            val o = client.newBotOptions()
            options = o
            if (model == null) model = o.defaultModel ?: o.models.firstOrNull()?.id
            errorText = null
        } catch (e: CancellationException) { throw e } catch (e: Exception) { errorText = UNREACHABLE_TEXT }
        loading = false
    }

    /** Makes the bot; returns it so its conversation can open. A refusal leaves the sheet as it was. */
    suspend fun create(): Bot? {
        if (!canCreate) return null
        creating = true
        return try { client.createBot(name.trim(), model).also { errorText = null } }
        catch (e: CancellationException) { throw e } catch (e: Exception) { errorText = "The bot wasn't made. Check that your computer is on and try again."; null }
        finally { creating = false }
    }
}
