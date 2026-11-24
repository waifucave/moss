package com.waifucave.moss.phone.ui

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowLeft
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ArrowUpward
import androidx.compose.material.icons.filled.Cancel
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.GraphicEq
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material.icons.outlined.Description
import androidx.compose.material.icons.outlined.AttachFile
import androidx.compose.material.icons.outlined.Extension
import androidx.compose.material.icons.outlined.Image
import androidx.compose.material.icons.outlined.Memory
import androidx.compose.material.icons.outlined.Mic
import androidx.compose.material.icons.outlined.PhotoCamera
import androidx.compose.material.icons.outlined.Speed
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.waifucave.moss.phone.model.AskQuestion
import com.waifucave.moss.phone.model.ComposerOffers
import com.waifucave.moss.phone.vm.ConversationModel
import kotlinx.coroutines.launch
import java.io.ByteArrayOutputStream

/** The rules the composer follows, kept out of the drawing so tests can hold them (the iPhone's `ComposerView`). */
object ComposerRules {
    enum class Primary { stop, send, voice }
    /** Stop while a turn runs, Send while there is text, otherwise the voice orb. */
    fun primary(running: Boolean, draft: String): Primary = when {
        running -> Primary.stop
        draft.isNotEmpty() -> Primary.send
        else -> Primary.voice
    }
    /** The microphone glyph shows only beside the voice orb. */
    fun showsMic(running: Boolean, draft: String) = draft.isEmpty() && !running
    /** The picker's rows, in the iPhone's order; a row only when this conversation offers it. */
    fun rows(offers: ComposerOffers, camera: Boolean): List<String> = buildList {
        if (offers.pictures && camera) add("Camera")
        if (offers.pictures) add("Photos")
        if (offers.files) add("Files")
        if (offers.commands.isNotEmpty()) add("Plugins")
        if (offers.efforts.isNotEmpty()) add("Effort")
        if (offers.models.isNotEmpty()) add("Model")
    }
}

private fun hasCamera(context: android.content.Context): Boolean =
    context.packageManager.hasSystemFeature(android.content.pm.PackageManager.FEATURE_CAMERA_ANY)

/**
 * The composer of both apps: a round pill at rest (plus, field, microphone glyph, and Send, Stop or the voice orb) that grows
 * into a rounded rectangle with a second row while its field has focus. The send contract: the field clears only when the
 * send was accepted. The microphone and the orb are visual only and hidden from TalkBack until there is voice.
 */
@Composable
fun Composer(model: ConversationModel, preset: ComposerPreset, pickerOpen: Boolean, onPicker: (Boolean) -> Unit) {
    val c = MossTheme.colors
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    var focused by remember { mutableStateOf(false) }
    val focus = remember { FocusRequester() }
    val focusManager = LocalFocusManager.current
    val expanded = focused || preset.focus
    val offers = model.offers ?: ComposerOffers()
    val hasRows = ComposerRules.rows(offers, true).isNotEmpty()
    val primary = ComposerRules.primary(model.isRunning, model.draft)

    LaunchedEffect(preset.focus) { if (preset.focus) runCatching { focus.requestFocus() } }

    val plus: @Composable () -> Unit = {
        Box(
            Modifier.size(44.dp).clip(CircleShape).clickable(role = Role.Button) { onPicker(!pickerOpen) }
                .semantics { contentDescription = "Add to message" },
            contentAlignment = Alignment.Center,
        ) { Icon(Icons.Filled.Add, null, tint = c.text, modifier = Modifier.size(24.dp).alpha(if (pickerOpen) 0f else 1f)) }
    }
    val field: @Composable (Modifier) -> Unit = { m ->
        Box(m, contentAlignment = Alignment.CenterStart) {
            if (model.draft.isEmpty()) Text(model.placeholder, style = MossType.body, color = c.secondary, maxLines = 1)
            BasicTextField(
                model.draft, { model.draft = it }, textStyle = MossType.body.copy(color = c.text), cursorBrush = SolidColor(c.text),
                maxLines = 5, keyboardOptions = KeyboardOptions(imeAction = ImeAction.Default),
                modifier = Modifier.fillMaxWidth().focusRequester(focus).onFocusChanged { focused = it.isFocused }
                    .semantics { contentDescription = model.placeholder },
            )
        }
    }
    val trailing: @Composable () -> Unit = {
        Row(verticalAlignment = Alignment.CenterVertically) {
            if (ComposerRules.showsMic(model.isRunning, model.draft)) {
                Box(Modifier.size(40.dp).clearAndSetSemantics {}, contentAlignment = Alignment.Center) {
                    Icon(Icons.Outlined.Mic, null, tint = c.text, modifier = Modifier.size(24.dp))
                }
            }
            when (primary) {
                ComposerRules.Primary.stop -> InverseCircle(36.dp, "Stop", onClick = { scope.launch { model.stop() } }) {
                    if (model.isInterrupting) CircularProgressIndicator(Modifier.size(18.dp), color = c.onInverse, strokeWidth = 2.dp)
                    else Icon(Icons.Filled.Stop, null, tint = c.onInverse, modifier = Modifier.size(20.dp))
                }
                ComposerRules.Primary.send -> InverseCircle(36.dp, "Send", enabled = model.canSend, onClick = {
                    scope.launch { if (model.send()) focusManager.clearFocus() }
                }) { Icon(Icons.Filled.ArrowUpward, null, tint = c.onInverse, modifier = Modifier.size(20.dp)) }
                ComposerRules.Primary.voice -> InverseCircle(34.dp, null) {
                    Icon(Icons.Filled.GraphicEq, null, tint = c.onInverse, modifier = Modifier.size(20.dp))
                }
            }
        }
    }

    Column(Modifier.fillMaxWidth()) {
        if (model.staged.isNotEmpty() || model.stagedFiles.isNotEmpty()) StagedStrip(model)
        val shape = RoundedCornerShape(if (expanded) 28.dp else 24.dp)
        Column(
            Modifier.padding(start = if (expanded) 12.dp else 28.dp, end = if (expanded) 12.dp else 28.dp, bottom = if (expanded) 12.dp else 8.dp)
                .fillMaxWidth()
                .shadow(6.dp, shape, ambientColor = c.text.copy(alpha = 0.25f), spotColor = c.text.copy(alpha = 0.25f))
                .background(c.softButton, shape)
                .border(0.5.dp, c.stroke, shape)
                .animateContentSize(),
        ) {
            if (expanded) {
                field(Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 16.dp, bottom = 6.dp))
                Row(Modifier.fillMaxWidth().padding(start = 4.dp, end = 4.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                    if (hasRows) plus()
                    Spacer(Modifier.weight(1f))
                    trailing()
                }
            } else {
                Row(
                    Modifier.fillMaxWidth().height(48.dp).padding(start = if (hasRows) 2.dp else 16.dp, end = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    if (hasRows) plus()
                    field(Modifier.weight(1f).padding(horizontal = 4.dp))
                    trailing()
                }
            }
        }
    }
}

@Composable
private fun InverseCircle(size: Dp, label: String?, enabled: Boolean = true, onClick: (() -> Unit)? = null, content: @Composable () -> Unit) {
    val c = MossTheme.colors
    val base = Modifier.size(44.dp)
    val m = if (onClick != null && label != null) base.clip(CircleShape).clickable(enabled = enabled, role = Role.Button, onClick = onClick).semantics { contentDescription = label }
            else base.clearAndSetSemantics {}
    Box(m, contentAlignment = Alignment.Center) {
        Box(Modifier.size(size).background(c.inverse, CircleShape).alpha(if (enabled) 1f else 0.5f), contentAlignment = Alignment.Center) { content() }
    }
}

@Composable
private fun StagedStrip(model: ConversationModel) {
    val c = MossTheme.colors
    Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 40.dp, vertical = 6.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
        for (image in model.staged) {
            Box {
                val bmp = remember(image.path) { BitmapFactory.decodeByteArray(image.thumbnail, 0, image.thumbnail.size) }
                if (bmp != null) Image(bmp.asImageBitmap(), null, contentScale = ContentScale.Crop, modifier = Modifier.size(56.dp).clip(RoundedCornerShape(12.dp)))
                else Box(Modifier.size(56.dp).background(c.softButton, RoundedCornerShape(12.dp)))
                Box(
                    Modifier.align(Alignment.TopEnd).offset(6.dp, (-6).dp).size(24.dp).clip(CircleShape).clickable { model.unstage(image) }
                        .semantics { contentDescription = "Remove picture" },
                ) { Icon(Icons.Filled.Cancel, null, tint = c.inverse) }
            }
        }
        for (file in model.stagedFiles) FileChip(file) { model.unstageFile(file) }
    }
}

/** A file staged for the next message: its name and size, and an x that takes it off. */
@Composable
private fun FileChip(file: com.waifucave.moss.phone.model.StagedFile, onRemove: () -> Unit) {
    val c = MossTheme.colors
    Row(
        Modifier.background(c.softButton, RoundedCornerShape(18.dp)).border(0.5.dp, c.stroke, RoundedCornerShape(18.dp)).padding(start = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Icons.Outlined.Description, null, tint = c.secondary, modifier = Modifier.size(20.dp))
        Spacer(Modifier.width(8.dp))
        Column(Modifier.widthIn(max = 200.dp).semantics(mergeDescendants = true) {}) {
            Text(file.name, style = MossType.line, fontWeight = FontWeight.SemiBold, color = c.text, maxLines = 1,
                overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis)
            Text(com.waifucave.moss.phone.model.byteCount(file.size), style = MossType.caption, color = c.secondary)
        }
        Box(
            Modifier.size(44.dp).clip(CircleShape).clickable(role = Role.Button, onClick = onRemove)
                .semantics { contentDescription = "Remove ${file.name}" },
            contentAlignment = Alignment.Center,
        ) { Icon(Icons.Filled.Cancel, null, tint = c.inverse, modifier = Modifier.size(22.dp)) }
    }
}

private enum class Page { rows, effort, model, plugins }

/**
 * The plus's own panel of large rows: Camera and Photos where the conversation takes pictures, Plugins when it lists
 * commands, Effort, and Model in a coding session. A row is shown only when offered.
 */
@Composable
fun ComposerPicker(model: ConversationModel, onClose: () -> Unit, modifier: Modifier = Modifier) {
    val c = MossTheme.colors
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val offers = model.offers ?: ComposerOffers()
    var page by remember { mutableStateOf(Page.rows) }
    val camera = remember { hasCamera(context) } || LocalStill.current

    fun stage(bmp: Bitmap) {
        val full = ByteArrayOutputStream().also { bmp.compress(Bitmap.CompressFormat.JPEG, 85, it) }.toByteArray()
        val side = 168
        val thumb = Bitmap.createScaledBitmap(bmp, side, (side * bmp.height / bmp.width.coerceAtLeast(1)).coerceAtLeast(1), true)
        val small = ByteArrayOutputStream().also { thumb.compress(Bitmap.CompressFormat.PNG, 100, it) }.toByteArray()
        scope.launch { model.stage(full, small) }
    }
    val photos = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        if (uri != null) context.contentResolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it) }?.let(::stage)
    }
    val takePicture = rememberLauncherForActivityResult(ActivityResultContracts.TakePicturePreview()) { bmp -> if (bmp != null) stage(bmp) }
    val pickFile = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri == null) return@rememberLauncherForActivityResult
        val resolver = context.contentResolver
        var name = uri.lastPathSegment ?: "File"; var size = -1L
        resolver.query(uri, arrayOf(android.provider.OpenableColumns.DISPLAY_NAME, android.provider.OpenableColumns.SIZE), null, null, null)?.use { cur ->
            if (cur.moveToFirst()) {
                cur.getString(0)?.let { name = it }
                if (!cur.isNull(1)) size = cur.getLong(1)
            }
        }
        // The size is checked before anything is read: a file over the limit is never loaded.
        scope.launch { model.stageFile(name, size) { resolver.openInputStream(uri)?.use { it.readBytes() } } }
    }

    Column(
        modifier.widthIn(max = 300.dp).fillMaxWidth()
            .shadow(16.dp, RoundedCornerShape(32.dp), ambientColor = c.text.copy(alpha = 0.3f), spotColor = c.text.copy(alpha = 0.3f))
            .background(if (c.dark) c.card else c.background, RoundedCornerShape(32.dp))
            .border(0.5.dp, c.stroke, RoundedCornerShape(32.dp))
            .heightIn(max = 420.dp).verticalScroll(rememberScrollState())
            .padding(10.dp),
    ) {
        when (page) {
            Page.rows -> {
                if (offers.pictures && camera) PickerRow("Camera", Icons.Outlined.PhotoCamera) { onClose(); takePicture.launch(null) }
                if (offers.pictures) PickerRow("Photos", Icons.Outlined.Image) {
                    onClose(); photos.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
                }
                if (offers.files) PickerRow("Files", Icons.Outlined.AttachFile) { onClose(); pickFile.launch(arrayOf("*/*")) }
                if (offers.commands.isNotEmpty()) PickerRow("Plugins", Icons.Outlined.Extension, chevron = true) { page = Page.plugins }
                if (offers.efforts.isNotEmpty()) PickerRow("Effort", Icons.Outlined.Speed, value = offers.effort?.replaceFirstChar { it.uppercase() }, chevron = true) { page = Page.effort }
                if (offers.models.isNotEmpty()) PickerRow("Model", Icons.Outlined.Memory, value = offers.models.firstOrNull { it.id == offers.model }?.name, chevron = true) { page = Page.model }
            }
            Page.effort -> {
                PickerBack("Effort") { page = Page.rows }
                offers.efforts.forEach { level ->
                    PickerRow(level.replaceFirstChar { it.uppercase() }, Icons.Outlined.Speed, selected = level == offers.effort) { scope.launch { model.setEffort(level) }; onClose() }
                }
            }
            Page.model -> {
                PickerBack("Model") { page = Page.rows }
                offers.models.forEach { choice ->
                    PickerRow(choice.name, Icons.Outlined.Memory, selected = choice.id == offers.model) { scope.launch { model.setModel(choice) }; onClose() }
                }
            }
            Page.plugins -> {
                PickerBack("Plugins") { page = Page.rows }
                offers.commands.forEach { command -> PickerRow(command.title, Icons.Outlined.Extension) { scope.launch { model.run(command) }; onClose() } }
            }
        }
    }
}

@Composable
private fun PickerRow(title: String, icon: ImageVector, value: String? = null, selected: Boolean = false, chevron: Boolean = false, onClick: () -> Unit) {
    val c = MossTheme.colors
    Row(
        Modifier.fillMaxWidth().heightIn(min = 64.dp).clip(RoundedCornerShape(22.dp))
            .selectable(selected = selected, role = Role.Button, onClick = onClick)
            .semantics { if (value != null) stateDescription = value }
            .padding(horizontal = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(44.dp).background(c.text.copy(alpha = 0.08f), CircleShape), contentAlignment = Alignment.Center) {
            Icon(icon, null, tint = c.text, modifier = Modifier.size(22.dp))
        }
        Spacer(Modifier.width(16.dp))
        Text(title, style = MossType.body, color = c.text, modifier = Modifier.weight(1f))
        if (value != null && !selected) Text(value, style = MossType.line, color = c.secondary, modifier = Modifier.padding(end = 6.dp))
        if (selected) Icon(Icons.Filled.Check, null, tint = c.text, modifier = Modifier.size(20.dp))
        else if (chevron) Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, null, tint = c.secondary, modifier = Modifier.size(20.dp))
    }
}

@Composable
private fun PickerBack(title: String, onClick: () -> Unit) {
    val c = MossTheme.colors
    Row(
        Modifier.fillMaxWidth().heightIn(min = 48.dp).clip(RoundedCornerShape(22.dp)).clickable(role = Role.Button, onClick = onClick)
            .semantics(mergeDescendants = true) { contentDescription = "Back from $title" }.padding(horizontal = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Icons.AutoMirrored.Filled.KeyboardArrowLeft, null, tint = c.text)
        Spacer(Modifier.width(6.dp))
        Text(title, style = MossType.body, color = c.text)
    }
}

/** While a question waits, the composer's place becomes this box, in the composer's own material. */
@Composable
fun QuestionComposer(question: AskQuestion, onSubmit: suspend (Map<String, String>) -> Boolean) {
    val c = MossTheme.colors
    val scope = rememberCoroutineScope()
    var selected by remember(question.callId) { mutableStateOf(setOf<Int>()) }
    var other by remember(question.callId) { mutableStateOf("") }
    var submitting by remember { mutableStateOf(false) }
    val answer = (selected.sorted().map { question.options[it].label } + listOfNotNull(other.trim().ifEmpty { null })).joinToString(", ")
    val shape = RoundedCornerShape(28.dp)
    Column(
        Modifier.padding(start = 12.dp, end = 12.dp, bottom = 12.dp).fillMaxWidth()
            .shadow(6.dp, shape, ambientColor = c.text.copy(alpha = 0.25f), spotColor = c.text.copy(alpha = 0.25f))
            .background(c.softButton, shape).border(0.5.dp, c.stroke, shape).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        question.header?.let { Text(it, style = MossType.footnote, fontWeight = FontWeight.SemiBold, color = c.secondary) }
        Text(question.text, style = MossType.body, color = c.text)
        Column {
            question.options.forEachIndexed { i, o ->
                if (i > 0) HorizontalDivider(color = c.stroke)
                val on = i in selected
                Row(
                    Modifier.fillMaxWidth().heightIn(min = 48.dp)
                        .selectable(selected = on, role = if (question.multiSelect) Role.Checkbox else Role.RadioButton) {
                            selected = if (question.multiSelect) (if (on) selected - i else selected + i) else setOf(i)
                        }
                        .padding(vertical = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(Modifier.weight(1f)) {
                        Text(o.label, style = MossType.body, color = c.text)
                        o.detail?.let { Text(it, style = MossType.footnote, color = c.secondary) }
                    }
                    Icon(Icons.Filled.Check, null, tint = c.text, modifier = Modifier.size(20.dp).alpha(if (on) 1f else 0f))
                }
            }
            HorizontalDivider(color = c.stroke)
            Box(Modifier.fillMaxWidth().padding(vertical = 12.dp)) {
                if (other.isEmpty()) Text("Something else", style = MossType.body, color = c.secondary)
                BasicTextField(other, { other = it }, textStyle = MossType.body.copy(color = c.text), cursorBrush = SolidColor(c.text),
                    modifier = Modifier.fillMaxWidth().semantics { contentDescription = "Something else" })
            }
        }
        Row(Modifier.fillMaxWidth()) {
            Spacer(Modifier.weight(1f))
            Button(
                onClick = {
                    submitting = true
                    scope.launch { onSubmit(mapOf((question.header ?: question.text) to answer)); submitting = false }
                },
                enabled = answer.isNotEmpty() && !submitting,
                colors = ButtonDefaults.buttonColors(containerColor = c.inverse, contentColor = c.onInverse,
                    disabledContainerColor = c.inverse.copy(alpha = 0.12f), disabledContentColor = c.secondary),
            ) { Text("Submit", fontWeight = FontWeight.SemiBold) }
        }
    }
}

