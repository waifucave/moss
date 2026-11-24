package com.waifucave.moss.phone.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.Folder
import androidx.compose.material.icons.outlined.QrCodeScanner
import androidx.compose.material.icons.outlined.SentimentSatisfied
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.waifucave.moss.phone.model.PairedComputer
import com.waifucave.moss.phone.model.PairingProposal
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import com.waifucave.moss.phone.model.Bot
import com.waifucave.moss.phone.vm.NewBotModel
import com.waifucave.moss.phone.vm.NewSessionModel
import com.waifucave.moss.phone.vm.PairingModel
import com.waifucave.moss.phone.vm.SettingsModel
import com.waifucave.moss.phone.vm.message
import kotlinx.coroutines.launch

@Composable
private fun BackBar(title: String, onBack: () -> Unit, container: androidx.compose.ui.graphics.Color) {
    CenterAlignedTopAppBar(
        title = { Text(title, style = MossType.title) },
        navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") } },
        colors = TopAppBarDefaults.centerAlignedTopAppBarColors(containerColor = container),
    )
}

@Composable
private fun SectionTitle(text: String) {
    Text(text, style = MossType.footnote, fontWeight = FontWeight.Medium, color = MossTheme.colors.secondary,
        modifier = Modifier.padding(start = 32.dp, end = 32.dp, top = 22.dp, bottom = 6.dp).semantics { heading() })
}

@Composable
private fun Group(content: @Composable ColumnScope.() -> Unit) {
    val c = MossTheme.colors
    Column(Modifier.padding(horizontal = 16.dp).fillMaxWidth().background(c.card, RoundedCornerShape(20.dp)).padding(vertical = 4.dp), content = content)
}

@Composable
private fun ValueRow(label: String, value: String) {
    val c = MossTheme.colors
    Row(Modifier.fillMaxWidth().heightIn(min = 52.dp).padding(horizontal = 16.dp).semantics(mergeDescendants = true) {}, verticalAlignment = Alignment.CenterVertically) {
        Text(label, style = MossType.body, color = c.text, modifier = Modifier.weight(1f))
        Text(value, style = MossType.body, color = c.secondary)
    }
}

/** Settings: the paired computer, Unpair behind a confirmation, and the app's version. */
@Composable
fun SettingsScreen(model: SettingsModel, appName: String, onUnpaired: () -> Unit, onBack: () -> Unit) {
    val c = MossTheme.colors
    val scope = rememberCoroutineScope()
    val now = nowMs()
    LaunchedEffect(model) { model.load() }
    Scaffold(containerColor = c.grouped, topBar = { BackBar("Settings", onBack, c.grouped) }) { pad ->
        Column(Modifier.padding(pad).fillMaxSize().verticalScroll(rememberScrollState())) {
            SectionTitle("Paired computer")
            Group {
                val pc = model.computer
                if (pc != null) {
                    ValueRow("Name", pc.name)
                    HorizontalDivider(Modifier.padding(start = 16.dp), color = c.stroke)
                    ValueRow("This phone", pc.deviceName)
                    HorizontalDivider(Modifier.padding(start = 16.dp), color = c.stroke)
                    ValueRow("Status", model.lastSeenText(now))
                } else Text("Not paired", style = MossType.body, color = c.secondary, modifier = Modifier.padding(16.dp))
            }
            Spacer(Modifier.height(22.dp))
            Group {
                Text(
                    "Unpair ${model.computer?.name ?: "computer"}", style = MossType.body, color = if (model.computer != null) c.destructive else c.secondary,
                    modifier = Modifier.fillMaxWidth().clickable(enabled = model.computer != null, role = Role.Button) { model.confirmingUnpair = true }
                        .heightIn(min = 52.dp).padding(horizontal = 16.dp, vertical = 15.dp),
                )
            }
            Text("This phone forgets the computer. To use $appName again, pair it once more.", style = MossType.footnote, color = c.secondary,
                modifier = Modifier.padding(start = 32.dp, end = 32.dp, top = 8.dp))
            SectionTitle("About")
            Group { ValueRow("Version", model.version) }
        }
    }
    if (model.confirmingUnpair) {
        AlertDialog(
            onDismissRequest = { model.confirmingUnpair = false },
            title = { Text("Unpair from ${model.computer?.name ?: "this computer"}?") },
            text = { Text("You will have to scan the code on your computer again.") },
            confirmButton = {
                TextButton(onClick = { scope.launch { model.unpair(); onUnpaired() } }) { Text("Unpair", color = c.destructive) }
            },
            dismissButton = { TextButton(onClick = { model.confirmingUnpair = false }) { Text("Cancel", color = c.text) } },
            containerColor = c.card,
        )
    }
}

/**
 * First run: scan the code shown on the computer, check the four words, confirm. The same screen in both apps. With
 * `codeEntry` (the real engine client, until the camera scanner exists), the pairing code is pasted into a field instead
 * of the sample code's button.
 */
@Composable
fun PairingScreen(model: PairingModel, appName: String, codeEntry: Boolean = false, onPaired: (PairedComputer) -> Unit) {
    val c = MossTheme.colors
    val scope = rememberCoroutineScope()
    Scaffold(
        containerColor = c.background,
        topBar = { CenterAlignedTopAppBar(title = { Text("Pair with your computer", style = MossType.title) },
            colors = TopAppBarDefaults.centerAlignedTopAppBarColors(containerColor = c.background)) },
        bottomBar = {
            when (val step = model.step) {
                is PairingModel.Step.Confirming -> BottomButtons {
                    PrimaryButton("They match") { scope.launch { model.confirm() } }
                    OutlinedButton(onClick = { scope.launch { model.cancel() } }, modifier = Modifier.fillMaxWidth().height(52.dp)) { Text("They don't match", color = c.text) }
                }
                is PairingModel.Step.Paired -> BottomButtons { PrimaryButton("Done") { onPaired(step.computer) } }
                is PairingModel.Step.Failed -> BottomButtons { PrimaryButton("Try again") { model.retry() } }
                else -> {}
            }
        },
    ) { pad ->
        Column(
            Modifier.padding(pad).fillMaxSize().verticalScroll(rememberScrollState()).padding(top = 16.dp, bottom = 16.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            when (val step = model.step) {
                PairingModel.Step.Scanning, PairingModel.Step.Checking -> {
                    Text("On your computer, open $appName and choose Pair a phone. Then point this camera at the code.",
                        style = MossType.body, color = c.secondary, textAlign = TextAlign.Center, modifier = Modifier.padding(horizontal = 24.dp))
                    Spacer(Modifier.height(20.dp))
                    Box(
                        Modifier.padding(horizontal = 32.dp).fillMaxWidth().aspectRatio(1f).background(c.softButton, RoundedCornerShape(28.dp))
                            .semantics { contentDescription = "Camera for the pairing code" },
                        contentAlignment = Alignment.Center,
                    ) {
                        // The camera that reads the code arrives with the shared core; until then a sample code stands in, as on the iPhone.
                        Column(horizontalAlignment = Alignment.CenterHorizontally) {
                            Icon(Icons.Outlined.QrCodeScanner, null, tint = c.secondary, modifier = Modifier.size(64.dp))
                            Spacer(Modifier.height(10.dp))
                            Text("No camera here.", style = MossType.footnote, color = c.secondary)
                            Spacer(Modifier.height(10.dp))
                            if (!codeEntry) FilledTonalButton(onClick = { scope.launch { model.scanned("moss-pair:sample") } }) { Text("Use a sample code") }
                        }
                        if (step == PairingModel.Step.Checking) CircularProgressIndicator(color = c.text)
                    }
                    if (codeEntry) {
                        var code by remember { mutableStateOf("") }
                        Spacer(Modifier.height(16.dp))
                        OutlinedTextField(
                            value = code, onValueChange = { code = it }, singleLine = true,
                            label = { Text("Pairing code") },
                            modifier = Modifier.padding(horizontal = 32.dp).fillMaxWidth().semantics { contentDescription = "Pairing code" },
                        )
                        Spacer(Modifier.height(10.dp))
                        FilledTonalButton(onClick = { scope.launch { model.scanned(code.trim()) } }, enabled = code.isNotBlank() && step == PairingModel.Step.Scanning) { Text("Pair") }
                    }
                }
                is PairingModel.Step.Confirming -> Words(step.proposal)
                is PairingModel.Step.Paired -> Done(Icons.Outlined.CheckCircle, "Paired with ${step.computer.name}", "This phone can now see $appName and answer cards from it.")
                is PairingModel.Step.Failed -> Done(Icons.Outlined.ErrorOutline, null, step.error.message)
            }
        }
    }
}

@Composable
private fun BottomButtons(content: @Composable ColumnScope.() -> Unit) {
    Column(Modifier.fillMaxWidth().navigationBarsPadding().padding(horizontal = 24.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp), content = content)
}

@Composable
private fun PrimaryButton(text: String, onClick: () -> Unit) {
    val c = MossTheme.colors
    Button(onClick = onClick, modifier = Modifier.fillMaxWidth().height(52.dp),
        colors = ButtonDefaults.buttonColors(containerColor = c.inverse, contentColor = c.onInverse)) { Text(text, fontWeight = FontWeight.SemiBold) }
}

@Composable
private fun Words(p: PairingProposal) {
    val c = MossTheme.colors
    Text("Do these four words match the ones on ${p.computer}?", style = MossType.title.copy(fontSize = 20.sp, lineHeight = 26.sp), color = c.text,
        textAlign = TextAlign.Center, modifier = Modifier.padding(horizontal = 24.dp, vertical = 8.dp).semantics { heading() })
    Spacer(Modifier.height(14.dp))
    Column(
        Modifier.padding(horizontal = 32.dp).clearAndSetSemantics { contentDescription = "The four words: ${p.words.joinToString(", ")}" },
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        p.words.forEachIndexed { i, w ->
            Row(Modifier.fillMaxWidth().background(c.softButton, RoundedCornerShape(14.dp)).padding(horizontal = 16.dp, vertical = 12.dp),
                verticalAlignment = Alignment.CenterVertically) {
                Text("${i + 1}", style = MossType.footnote, color = c.secondary, modifier = Modifier.width(22.dp))
                Text(w, style = MossType.title.copy(fontSize = 22.sp, lineHeight = 28.sp, fontWeight = FontWeight.Medium), color = c.text)
            }
        }
    }
    Spacer(Modifier.height(14.dp))
    Text("Only confirm if all four are the same.", style = MossType.footnote, color = c.secondary)
}

@Composable
private fun Done(icon: androidx.compose.ui.graphics.vector.ImageVector, title: String?, text: String) {
    val c = MossTheme.colors
    Spacer(Modifier.height(48.dp))
    Icon(icon, null, tint = c.text, modifier = Modifier.size(64.dp))
    Spacer(Modifier.height(16.dp))
    if (title != null) Text(title, style = MossType.title.copy(fontSize = 22.sp, lineHeight = 28.sp), color = c.text, modifier = Modifier.semantics { heading() })
    Spacer(Modifier.height(8.dp))
    Text(text, style = MossType.body, color = c.secondary, textAlign = TextAlign.Center, modifier = Modifier.padding(horizontal = 32.dp))
}

/** MOSS Code's new session: the agent, its model and effort, and the folder. A full-screen dialog, Android's way to make something. */
@Composable
fun NewSessionScreen(model: NewSessionModel, onStarted: (String) -> Unit, onCancel: () -> Unit) {
    val c = MossTheme.colors
    val scope = rememberCoroutineScope()
    LaunchedEffect(model) { model.load() }
    Scaffold(
        containerColor = c.grouped,
        topBar = {
            TopAppBar(
                title = { Text("New session", style = MossType.title) },
                navigationIcon = { IconButton(onClick = onCancel) { Icon(Icons.Filled.Close, "Cancel") } },
                actions = {
                    TextButton(onClick = { scope.launch { model.start()?.let(onStarted) } }, enabled = model.canStart) {
                        Text("Start", fontWeight = FontWeight.SemiBold, color = if (model.canStart) c.text else c.secondary)
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = c.grouped),
            )
        },
    ) { pad ->
        Column(Modifier.padding(pad).fillMaxSize().verticalScroll(rememberScrollState()).padding(bottom = 24.dp)) {
            when {
                model.loadFailed -> Group { UnreachableNotice(null, null, { scope.launch { model.load() } }, Modifier.padding(16.dp)) }
                model.loading -> Loading(Modifier.padding(top = 48.dp))
                else -> {
                    SectionTitle("Agent")
                    Group {
                        model.backends.forEachIndexed { i, b ->
                            if (i > 0) HorizontalDivider(Modifier.padding(start = 56.dp), color = c.stroke)
                            ChoiceRow(b.name, model.backend == b.id, { scope.launch { model.chooseBackend(b.id) } }) { AgentMark(b.id, 26.dp) }
                        }
                    }
                    val o = model.options
                    if (o != null && !o.known) Text("This agent shows its models once the session starts.", style = MossType.footnote, color = c.secondary,
                        modifier = Modifier.padding(start = 32.dp, end = 32.dp, top = 8.dp))
                    if (model.modelChoices.isNotEmpty()) {
                        SectionTitle("Model")
                        Group {
                            model.modelChoices.forEachIndexed { i, m ->
                                if (i > 0) HorizontalDivider(Modifier.padding(start = 16.dp), color = c.stroke)
                                ChoiceRow(m.name, model.model == m.id, { model.chooseModel(m.id) })
                            }
                        }
                        if (model.efforts.isNotEmpty()) {
                            SectionTitle("Effort")
                            SingleChoiceSegmentedButtonRow(Modifier.padding(horizontal = 16.dp).fillMaxWidth()) {
                                model.efforts.forEachIndexed { i, e ->
                                    SegmentedButton(
                                        selected = model.effort == e, onClick = { model.effort = e },
                                        shape = SegmentedButtonDefaults.itemShape(i, model.efforts.size),
                                        colors = SegmentedButtonDefaults.colors(activeContainerColor = c.card, inactiveContainerColor = c.softButton,
                                            activeContentColor = c.text, inactiveContentColor = c.text, activeBorderColor = c.stroke, inactiveBorderColor = c.stroke),
                                    ) { Text(e.replaceFirstChar { it.uppercase() }) }
                                }
                            }
                        }
                    }
                    SectionTitle("Folder")
                    Group {
                        model.folders.forEach { f ->
                            ChoiceRow(f, model.typedFolder.isEmpty() && model.pickedFolder == f, { model.pickedFolder = f; model.typedFolder = "" }) {
                                Icon(Icons.Outlined.Folder, null, tint = c.text, modifier = Modifier.size(24.dp))
                            }
                            HorizontalDivider(Modifier.padding(start = 56.dp), color = c.stroke)
                        }
                        OutlinedTextField(
                            model.typedFolder, { model.typedFolder = it }, placeholder = { Text("Another folder: type or paste a path", fontFamily = FontFamily.Monospace) },
                            textStyle = MossType.body.copy(fontFamily = FontFamily.Monospace, color = c.text),
                            modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp),
                            colors = OutlinedTextFieldDefaults.colors(focusedBorderColor = c.text, unfocusedBorderColor = c.stroke, cursorColor = c.text),
                        )
                    }
                    Text("Folders of your existing sessions come first. A path is the folder's place on your computer.", style = MossType.footnote,
                        color = c.secondary, modifier = Modifier.padding(start = 32.dp, end = 32.dp, top = 8.dp))
                    model.errorText?.let { e ->
                        Row(Modifier.padding(horizontal = 32.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                            Icon(Icons.Outlined.ErrorOutline, null, tint = c.secondary, modifier = Modifier.size(18.dp))
                            Spacer(Modifier.width(8.dp))
                            Text(e, style = MossType.line, color = c.secondary)
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun ChoiceRow(title: String, selected: Boolean, onClick: () -> Unit, leading: (@Composable () -> Unit)? = null) {
    val c = MossTheme.colors
    Row(
        Modifier.fillMaxWidth().heightIn(min = 52.dp).selectable(selected, role = Role.RadioButton, onClick = onClick).padding(horizontal = 16.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (leading != null) { Box(Modifier.size(28.dp), contentAlignment = Alignment.Center) { leading() }; Spacer(Modifier.width(12.dp)) }
        Text(title, style = MossType.body, color = c.text, modifier = Modifier.weight(1f))
        if (selected) Icon(Icons.Filled.Check, null, tint = c.text, modifier = Modifier.size(20.dp))
    }
}

/** What the plus does in MOSS: make a bot. A name, and a model with the computer's default preselected. */
@Composable
fun NewBotSheet(model: NewBotModel, computer: String?, onCreated: (Bot) -> Unit, onCancel: () -> Unit) {
    val c = MossTheme.colors
    val scope = rememberCoroutineScope()
    val focus = remember { FocusRequester() }
    var menu by remember { mutableStateOf(false) }
    LaunchedEffect(model) { model.load(); runCatching { focus.requestFocus() } }
    ModalBottomSheet(onDismissRequest = onCancel, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = c.card) {
        Column(Modifier.fillMaxWidth().imePadding().padding(start = 24.dp, end = 24.dp, bottom = 24.dp)) {
            Text("New bot", style = MossType.title.copy(fontSize = 20.sp, lineHeight = 26.sp), color = c.text, modifier = Modifier.semantics { heading() })
            Spacer(Modifier.height(16.dp))
            OutlinedTextField(
                model.name, { model.name = it }, label = { Text("Name") }, singleLine = true,
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Words, imeAction = ImeAction.Done),
                modifier = Modifier.fillMaxWidth().focusRequester(focus),
                colors = OutlinedTextFieldDefaults.colors(focusedBorderColor = c.text, unfocusedBorderColor = c.stroke, cursorColor = c.text, focusedLabelColor = c.text),
            )
            Text("The bot is made on ${computer ?: "your computer"} and its conversation opens here.", style = MossType.footnote, color = c.secondary,
                modifier = Modifier.padding(start = 4.dp, top = 6.dp))
            Spacer(Modifier.height(16.dp))
            val o = model.options
            if (model.loading) Loading()
            else if (o != null && o.models.isNotEmpty()) {
                ExposedDropdownMenuBox(menu, { menu = it }) {
                    OutlinedTextField(
                        o.models.firstOrNull { it.id == model.model }?.name ?: "", {}, readOnly = true, label = { Text("Model") },
                        trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(menu) },
                        modifier = Modifier.fillMaxWidth().menuAnchor(MenuAnchorType.PrimaryNotEditable),
                        colors = OutlinedTextFieldDefaults.colors(focusedBorderColor = c.text, unfocusedBorderColor = c.stroke, focusedLabelColor = c.text),
                    )
                    ExposedDropdownMenu(menu, { menu = false }) {
                        o.models.forEach { m -> DropdownMenuItem({ Text(m.name) }, onClick = { model.model = m.id; menu = false }) }
                    }
                }
            }
            model.errorText?.let { e ->
                Row(Modifier.padding(top = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Outlined.ErrorOutline, null, tint = c.secondary, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.width(8.dp))
                    Text(e, style = MossType.footnote, color = c.secondary)
                }
            }
            Spacer(Modifier.height(24.dp))
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                OutlinedButton(onClick = onCancel, modifier = Modifier.weight(1f).height(52.dp)) { Text("Cancel", color = c.text) }
                Button(
                    onClick = { scope.launch { model.create()?.let(onCreated) } }, enabled = model.canCreate, modifier = Modifier.weight(1f).height(52.dp),
                    colors = ButtonDefaults.buttonColors(containerColor = c.inverse, contentColor = c.onInverse,
                        disabledContainerColor = c.text.copy(alpha = 0.12f), disabledContentColor = c.secondary),
                ) { Text("Create", fontWeight = FontWeight.SemiBold) }
            }
        }
    }
}
