package com.waifucave.moss.phone

import com.waifucave.moss.phone.client.FakeEngineClient
import com.waifucave.moss.phone.client.FakeEngineClient.Scenario
import com.waifucave.moss.phone.client.SampleData
import com.waifucave.moss.phone.model.*
import com.waifucave.moss.phone.vm.*
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test

/** The iPhone's `ViewModelTests`, case for case, against the same fake and sample data. */
class ViewModelTest {
    private fun fake(s: Scenario = Scenario.idle) = FakeEngineClient(s)

    @Test fun botsListPinsAndOrders() = runTest {
        val m = BotsListModel(fake(), MemoryPinStore(listOf("pip", "alpha")))
        m.load()
        assertEquals(listOf("pip", "alpha"), m.pinned.map { it.id })   // in the order pinned
        assertFalse(m.others.any { it.id == "alpha" })
        assertEquals("luna", m.others.first().id)                       // newest conversation first
        m.togglePin("juniper")
        assertEquals(listOf("pip", "alpha", "juniper"), m.pinned.map { it.id })
        assertEquals(3, m.unreadCount)
    }

    @Test fun sessionsGroupedByProject() = runTest {
        val m = SessionsListModel(fake())
        m.load()
        assertEquals(listOf("moss", "website", "tools"), m.groups.map { it.project })
        val moss = m.groups[0].sessions
        assertEquals(listOf("c1", "c2", "c3"), moss.map { it.id })   // newest first
        assertEquals(SessionBadge.running, moss.first { it.id == "c1" }.badge)
        assertEquals(SessionBadge.needsYou, moss.first { it.id == "c2" }.badge)
        assertEquals(SessionBadge.waiting, moss.first { it.id == "c3" }.badge)
        assertEquals(2, m.needsYouCount)
    }

    @Test fun sendClearsDraftAndShowsStatusLineThenReply() = runTest {
        val c = fake()
        val bot = SampleData.bots[0]
        val m = ConversationModel(ConversationModel.Source.OfBot(bot), c, makeID = { "id-1" })
        m.load()
        val events = Channel<EngineEvent>(Channel.UNLIMITED)
        backgroundScope.launch { c.events().collect { events.send(it) } }
        testScheduler.runCurrent()
        m.draft = "  Hello  "
        m.send()
        assertEquals("", m.draft)
        assertEquals("Hello", c.sent.first().second); assertEquals("id-1", c.sent.first().third)
        while (m.statusLine == null) m.apply(events.receive())
        assertEquals("Alpha is thinking", m.statusLine); assertTrue(m.isRunning)
        c.finishTurn(bot.mainSession)
        while (m.statusLine != null) m.apply(events.receive())
        assertFalse(m.isRunning)
        assertEquals(MessageRole.bot, m.messages.last().role)
    }

    @Test fun sendFailureKeepsTheWords() = runTest {
        val c = fake()
        val m = ConversationModel(ConversationModel.Source.OfBot(SampleData.bots[0]), c)
        m.load()
        m.draft = "keep me"
        c.failNext = FakeEngineClient.Failure("down")
        m.send()
        assertEquals("keep me", m.draft); assertNotNull(m.errorText)
    }

    @Test fun resendIsNotASecondMessage() = runTest {
        val c = fake()
        c.send("s_alpha", "a", "x")
        c.send("s_alpha", "a", "x")
        assertEquals(1, c.sent.size)
    }

    @Test fun stopCallsClient() = runTest {
        val c = fake(Scenario.midTurn)
        val m = ConversationModel(ConversationModel.Source.OfBot(SampleData.bots[0]), c)
        m.stop()
        assertEquals(listOf("s_alpha"), c.stopped)
        assertFalse(m.isInterrupting)
    }

    @Test fun cardsSplitByAppAndFallBackWhenTheOtherAppIsMissing() = runTest {
        val c = fake()
        val bots = CardsModel(c, PhoneApp.moss, { SampleData.now }, steppingClock())
        val code = CardsModel(c, PhoneApp.code, { SampleData.now }, steppingClock())
        bots.load(); code.load()
        assertEquals(setOf("card_0a1b2c3d", "card_55aa66bb"), bots.cards.map { it.id }.toSet())
        assertEquals(listOf("card_9f8e7d6c"), code.cards.map { it.id })
        c.setOtherAppInstalled(false)
        bots.load(); code.load()
        assertEquals(3, bots.cards.size); assertEquals(3, code.cards.size)
        val card = bots.cards.first { it.id == "card_0a1b2c3d" }
        bots.answerShown(card, card.options[0])
        assertFalse(bots.cards.any { it.id == card.id })
        assertEquals(card.id to card.options[0].id, c.answered.first())
    }

    @Test fun cardFailureKeepsCardAndOffersRetry() = runTest {
        val c = fake()
        val m = CardsModel(c, PhoneApp.moss, { SampleData.now }, steppingClock())
        m.load()
        val card = m.cards[0]
        c.failNext = FakeEngineClient.Failure("down")
        m.answerShown(card, card.options[0])
        assertEquals(2, m.cards.size); assertEquals(CardNote.failed, m.note(card))
        m.clearFailure(card)
        assertNull(m.note(card))
    }

    @Test fun expiredAndAnsweredElsewhereCards() = runTest {
        val c = FakeEngineClient(Scenario.cardStates)
        val m = CardsModel(c, PhoneApp.moss, { SampleData.now }, steppingClock())
        m.load()
        val expired = m.cards.first { it.id == "card_0a1b2c3d" }
        assertEquals(CardNote.expired, m.note(expired))
        m.answerShown(expired, expired.options[0])          // refused here, never sent
        assertTrue(c.answered.isEmpty())
        m.apply(EngineEvent.CardResolved("card_55aa66bb"))   // another device answered it
        assertEquals(CardNote.answeredElsewhere, m.note(m.cards.first { it.id == "card_55aa66bb" }))
        assertEquals(0, m.waitingCount)
        m.dismiss(expired)
        assertEquals(1, m.cards.size)
    }

    @Test fun answeringARaceLostCardSaysAnsweredElsewhere() = runTest {
        val c = FakeEngineClient(Scenario.cardStates)
        val m = CardsModel(c, PhoneApp.moss, { SampleData.now }, steppingClock())
        m.load()
        val card = m.cards.first { it.id == "card_55aa66bb" }
        m.answerShown(card, card.options[0])
        assertEquals(CardNote.answeredElsewhere, m.note(card))
    }

    @Test fun failedSendKeepsTextAndRetryUsesTheSameId() = runTest {
        val c = FakeEngineClient(Scenario.sendFails)
        var n = 0
        val m = ConversationModel(ConversationModel.Source.OfBot(SampleData.bots[0]), c, makeID = { n += 1; "id-$n" })
        m.load()
        m.draft = "hello"
        m.send()
        assertEquals("hello", m.draft); assertEquals("id-1", m.failedSend?.second)
        m.retry()
        assertEquals("id-1", m.failedSend?.second)        // the same id: never two messages
        assertEquals(1, n)
    }

    @Test fun unreachableComputerShowsInEveryList() = runTest {
        val c = FakeEngineClient(Scenario.unreachable)
        val b = BotsListModel(c, MemoryPinStore())
        b.load()
        assertTrue(b.loadFailed); assertTrue(b.loaded)
        assertEquals(ConnectionState.Unreachable(SampleData.now - 7_200_000), b.connection)
        val s = SessionsListModel(c)
        s.load()
        assertTrue(s.loadFailed)
    }

    @Test fun emptyListsAreEmptyNotFailed() = runTest {
        val c = FakeEngineClient(Scenario.empty)
        val b = BotsListModel(c, MemoryPinStore())
        b.load()
        assertTrue(b.loaded); assertFalse(b.loadFailed); assertTrue(b.rows.isEmpty())
        val s = SessionsListModel(c)
        s.load()
        assertTrue(s.groups.isEmpty())
    }

    @Test fun newSessionPreselectsLastUsedAndStarts() = runTest {
        val c = fake()
        val m = NewSessionModel(c, "Studio")
        m.load()
        assertEquals("claude-code", m.backend)                   // the last used agent
        assertEquals("claude-sonnet", m.model); assertEquals("medium", m.effort)
        assertEquals("home/Studio/moss", m.folders.first())      // folders of existing sessions first
        assertEquals("home/Studio/moss", m.folder)
        m.typedFolder = "  home/Studio/new-thing "
        assertEquals("home/Studio/new-thing", m.folder)
        val id = m.start()
        assertNotNull(id)
        assertEquals(StartRequest("claude-code", "Studio", "home/Studio/new-thing", "claude-sonnet", "medium"), c.started.first())
        assertTrue(c.sessions().any { it.id == id })
    }

    @Test fun newSessionDefaultsFollowTheAgentChosen() = runTest {
        val m = NewSessionModel(fake(), "Studio")
        m.load()
        m.chooseBackend("moss-code")
        assertEquals("kimi-k3", m.model); assertEquals("medium", m.effort)   // no recent choice: the defaults
        m.chooseBackend("gemini")
        assertEquals(false, m.options?.known); assertNull(m.model)
        m.chooseBackend("claude-code")
        m.chooseModel("claude-opus")
        assertEquals("medium", m.effort)   // the effort stays when the new model has it
    }

    @Test fun newSessionRefusesTheMossHomeAndEmptyFolders() = runTest {
        val m = NewSessionModel(fake(), "Studio")
        m.load()
        m.typedFolder = "home/.moss"
        assertNull(m.start()); assertNotNull(m.errorText)
        m.typedFolder = "../x"
        assertNull(m.start())
    }

    @Test fun settingsLastSeenAndUnpair() = runTest {
        val c = FakeEngineClient(Scenario.unreachable)
        val m = SettingsModel(c, "1.0 (1)")
        m.load()
        assertEquals("Studio", m.computer?.name)
        assertEquals("Last seen 2 hours ago", m.lastSeenText(SampleData.now))
        m.unpair()
        assertNull(m.computer)
        assertNull(c.pairedComputer())
        assertEquals(1, c.unpairCount)
    }

    @Test fun pairingHappyPath() = runTest {
        val c = fake(Scenario.unpaired)
        val p = PairingModel(c)
        p.scanned("moss-pair:abc")
        val step = p.step as PairingModel.Step.Confirming
        assertEquals(4, step.proposal.words.size)
        p.confirm()
        assertEquals(PairingModel.Step.Paired(PairedComputer("Studio", "Phone")), p.step)
        assertNotNull(c.pairedComputer())
    }

    @Test fun pairingRejectsForeignCodeAndCanCancel() = runTest {
        val c = fake(Scenario.unpaired)
        val p = PairingModel(c)
        p.scanned("https://example.com")
        assertEquals(PairingModel.Step.Failed(PairingError.unreadableCode), p.step)
        p.retry()
        p.scanned("moss-pair:abc")
        p.cancel()
        assertEquals(PairingModel.Step.Scanning, p.step)
        assertNull(c.pairedComputer())
    }

    @Test fun composerOffersOnlyWhatIsBehindADoor() = runTest {
        val c = fake()
        val bot = ConversationModel(ConversationModel.Source.OfBot(SampleData.bots[0]), c)
        bot.loadComposer()
        assertEquals(true, bot.offers?.pictures)
        assertTrue(bot.offers!!.models.isEmpty())           // a bot's phone composer has no Model row
        assertTrue(bot.offers!!.efforts.isEmpty())          // nor an Effort row
        val code = ConversationModel(ConversationModel.Source.OfSession(SampleData.sessions[1]), c)
        code.loadComposer()
        assertFalse(code.offers!!.models.isEmpty())
        val first = code.offers!!.efforts[0]
        code.setEffort(first)
        assertEquals(first, code.offers?.effort)
        val gpt = code.offers!!.models.first { it.id == "gpt-5" }
        code.setModel(gpt)
        assertEquals("gpt-5", code.offers?.model)
        assertEquals("gpt-5", c.models["c2"])
    }

    @Test fun questionIsAnsweredOnce() = runTest {
        val c = fake()
        val m = ConversationModel(ConversationModel.Source.OfSession(SampleData.sessions.first { it.id == "c4" }), c)
        m.loadComposer()
        assertNotNull(m.question)
        assertTrue(m.answerQuestion("ask_1", mapOf("Which colour should the new tag have?" to "Green")))
        assertNull(m.question)
        m.loadComposer()
        assertNull(m.question)
    }

    /** An answer or a skip carries the call the composer drew: for another call it is refused, and nothing is sent. */
    @Test fun anAnswerForAnotherCallIsRefused() = runTest {
        val c = fake()
        val m = ConversationModel(ConversationModel.Source.OfBot(SampleData.bots.first { it.id == "luna" }), c)
        m.loadComposer()
        assertEquals("ask_2", m.question?.callId)
        assertFalse(m.answerQuestion("ask_old", mapOf("Which folder should I keep this week's receipts in?" to "Taxes")))
        assertFalse(m.skipQuestion("ask_old"))
        assertTrue(c.questionsAnswered.isEmpty() && c.questionsSkipped.isEmpty())
        assertEquals("ask_2", m.question?.callId)
        assertNotNull(m.errorText)
    }

    /** A call of several questions is answered together: no answers until each has one, then each keyed by its own text. */
    @Test fun aCallOfSeveralQuestionsIsAnsweredTogether() = runTest {
        val q = AskQuestion("ask_3", listOf(
            AskQuestion.Part("Day", "Which day?", listOf(AskQuestion.Option("Monday"), AskQuestion.Option("Friday"))),
            AskQuestion.Part("Time", "What time?", listOf(AskQuestion.Option("Morning"), AskQuestion.Option("Evening")), multiSelect = true),
        ))
        var d = QuestionDraft(q).toggle(1, 0)
        assertNull(d.answers)
        assertEquals(1, d.unanswered)
        d = d.toggle(0, 1).toggle(1, 1).typed(1, "  or late  ")
        assertEquals(mapOf("Which day?" to "Friday", "What time?" to "Morning, Evening, or late"), d.answers)
        // A single-choice pick replaces the earlier one; a pick in one question never touches another's.
        assertEquals(setOf(0), d.toggle(0, 0).picked[0])
        assertEquals(setOf(0, 1), d.toggle(0, 0).picked[1])
    }

    /** Two questions that read the same would share one answer: never answered here, with the line that says so. */
    @Test fun aCallWhoseQuestionsReadTheSameGoesToTheComputer() = runTest {
        val twin = AskQuestion("ask_twin", listOf(
            AskQuestion.Part(null, "Which one?", listOf(AskQuestion.Option("A"))),
            AskQuestion.Part(null, "Which one?", listOf(AskQuestion.Option("B"))),
        ))
        assertFalse(twin.answerableHere)
        assertNull(QuestionDraft(twin).toggle(0, 0).toggle(0, 1).answers)
    }

    /** A bot's open question can be skipped; a coding agent's can't (it holds the agent until answered). */
    @Test fun aBotsQuestionCanBeSkippedAnAgentsCant() = runTest {
        val c = fake()
        val luna = SampleData.bots.first { it.id == "luna" }
        val m = ConversationModel(ConversationModel.Source.OfBot(luna), c)
        m.loadComposer()
        val q = m.question
        assertNotNull(q)
        assertTrue(m.canSkipQuestion)
        assertTrue(m.skipQuestion(q!!.callId))
        assertNull(m.question)
        assertEquals(listOf(luna.mainSession to q.callId), c.questionsSkipped)
        val agent = ConversationModel(ConversationModel.Source.OfSession(SampleData.sessions.first { it.id == "c4" }), c)
        agent.loadComposer()
        assertFalse(agent.canSkipQuestion)
        assertFalse(agent.skipQuestion("ask_1"))
    }

    /** Each closing record sets the state of the row where its question was asked, and is no row of its own. */
    @Test fun aClosedQuestionIsDrawnWhereItWasAskedWithHowItEnded() = runTest {
        val c = fake(Scenario.questionEnds)
        val m = ConversationModel(ConversationModel.Source.OfBot(SampleData.bots.first { it.id == "luna" }), c)
        m.load()
        val rows = m.messages.mapNotNull { it.question }
        assertEquals(6, rows.size)
        assertTrue(rows.none { it.closing })
        assertEquals(
            listOf("Answered", "Answered by a plugin", "Skipped", "Withdrawn", "Ended: your computer stopped", "Closed"),
            rows.map { it.state.status?.title },
        )
        assertEquals("calendar-sync", rows[1].state.status?.detail)
        // A closing record that arrives live updates the row; one whose question isn't shown stays as its own row.
        m.apply(EngineEvent.Message("s_luna", ChatMessage("x1", MessageRole.question, "", SampleData.now,
            question = AskedQuestion("call_nowhere", text = "", state = QuestionState.Skipped, closing = true))))
        assertEquals(7, m.messages.count { it.question != null })
    }

    @Test fun listenerSeesTheSnapshotOfARunningTurn() = runTest {
        // A screen that opens mid-turn shows the status line the engine already has (the fake's first events).
        val c = fake(Scenario.midTurn)
        val m = ConversationModel(ConversationModel.Source.OfBot(SampleData.bots[0]), c)
        val job = backgroundScope.launch { m.run() }
        testScheduler.runCurrent()
        assertEquals("Alpha is working", m.statusLine)
        assertTrue(m.messages.isNotEmpty())
        m.stop()
        testScheduler.runCurrent()
        assertNull(m.statusLine)
        assertEquals("Interrupted", m.messages.last().text)
        job.cancel()
    }

    @Test fun fileIsStagedSentAndCleared() = runTest {
        val c = fake()
        val m = ConversationModel(ConversationModel.Source.OfBot(SampleData.bots[0]), c)
        m.load(); m.loadComposer()
        assertEquals(true, m.offers?.files)
        m.stageFile("Quarterly report.pdf", 1_240_000) { ByteArray(1_240_000) }
        assertEquals(listOf("Quarterly report.pdf"), m.stagedFiles.map { it.name })
        assertEquals("1.2 MB", byteCount(m.stagedFiles[0].size))
        m.draft = "Here it is"
        assertTrue(m.send())
        assertTrue(m.stagedFiles.isEmpty())
        assertEquals(listOf("staged/s_alpha/Quarterly report.pdf"), c.stagedFiles)
    }

    @Test fun fileOverTheLimitIsRefusedBeforeItIsRead() = runTest {
        val c = fake()
        val m = ConversationModel(ConversationModel.Source.OfBot(SampleData.bots[0]), c)
        m.loadComposer()
        var read = false
        m.stageFile("Site backup.zip", 60_000_000) { read = true; null }
        assertFalse(read)
        assertTrue(m.stagedFiles.isEmpty()); assertTrue(c.stagedFiles.isEmpty())
        assertEquals("That file is too big. The limit is 50 MB.", m.errorText)
        // The engine refuses too when the size it was told was wrong.
        m.stageFile("tiny.bin", 10) { ByteArray((FakeEngineClient.FILE_LIMIT + 1).toInt()) }
        assertEquals("That file is too big. The limit is 50 MB.", m.errorText)
    }

    @Test fun newBotPreselectsTheDefaultModelAndOpensTheBot() = runTest {
        val c = fake()
        val m = NewBotModel(c)
        m.load()
        assertEquals("kimi-k3", m.model)
        assertFalse(m.canCreate)
        m.name = "  Hazel "
        val bot = m.create()!!
        assertEquals("Hazel", bot.name); assertEquals("kimi-k3", bot.model)
        assertTrue(c.bots().any { it.id == bot.id })
        assertEquals("Hello, I am Hazel. What would you like to do?", c.conversation(bot.id, null, 10).messages.single().text)
    }

    @Test fun newBotRefusalLeavesTheSheet() = runTest {
        val c = fake()
        val m = NewBotModel(c)
        m.load()
        m.name = "Hazel"
        c.failNext = FakeEngineClient.Failure("down")
        assertNull(m.create())
        assertNotNull(m.errorText); assertEquals("Hazel", m.name)
    }

    @Test fun anAnswerCarriesTheCardTheScreenDrew() = runTest {
        // The client is handed the card object itself (its hash and fields), never only its id.
        val c = fake()
        val m = CardsModel(c, PhoneApp.moss, { SampleData.now }, steppingClock())
        m.load()
        val drawn = m.cards.first()
        m.answerShown(drawn, drawn.options.first())
        assertEquals(drawn.id to drawn.options.first().id, c.answered.single())
    }

    @Test fun aMessageCarriesAtMostTenFiles() = runTest {
        val m = ConversationModel(ConversationModel.Source.OfBot(SampleData.bots[0]), fake())
        m.loadComposer()
        repeat(10) { m.stageFile("f$it.txt", 3) { "abc".toByteArray() } }
        assertEquals(10, m.stagedFiles.size)
        m.stageFile("f10.txt", 3) { "abc".toByteArray() }
        assertEquals(10, m.stagedFiles.size)
        assertEquals("A message can carry 10 files. Send these first.", m.errorText)
    }

    @Test fun theSixthBotOfTheDayIsRefusedInTheEnginesWords() = runTest {
        val c = fake()
        val m = NewBotModel(c)
        m.load()
        repeat(5) { m.name = "Bot $it"; assertNotNull(m.create()) }
        m.name = "One more"
        assertNull(m.create())
        assertTrue(m.errorText!!.startsWith("This phone has made 5 bots today"))
        assertEquals("One more", m.name)
    }
}
