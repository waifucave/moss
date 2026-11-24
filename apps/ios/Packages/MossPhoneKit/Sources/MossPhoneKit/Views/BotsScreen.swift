import SwiftUI

/// MOSS's list of bots, with a few pinned on top as large faces.
public struct BotsScreen: View {
    @Bindable var model: BotsListModel
    @Environment(\.nowMs) private var nowOverride
    let computer: String?

    public init(model: BotsListModel, computer: String?) { self.model = model; self.computer = computer }

    public var body: some View {
        List {
            if !model.pinned.isEmpty {
                Section {
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 100, maximum: 160), spacing: 12)], spacing: 14) {
                        ForEach(model.pinned) { row in
                            NavigationLink(value: row.bot) { PinnedFace(row: row) }
                                .buttonStyle(.plain)
                                .navigationLinkIndicatorVisibility(.hidden)
                                .contextMenu { Button("Unpin", systemImage: "pin.slash") { model.togglePin(row.id) } }
                        }
                    }
                    .padding(.vertical, 6)
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets(top: 4, leading: 8, bottom: 4, trailing: 8))
                }
            }
            Section {
                ForEach(model.others) { row in
                    NavigationLink(value: row.bot) { BotListRow(row: row, now: nowOverride ?? Int64(Date().timeIntervalSince1970 * 1000)) }
                        .swipeActions(edge: .leading) {
                            Button { model.togglePin(row.id) } label: { Label("Pin", systemImage: "pin") }.tint(.gray)
                        }
                        .contextMenu { Button("Pin to the top", systemImage: "pin") { model.togglePin(row.id) } }
                }
            } header: { if !model.pinned.isEmpty { Text("Bots") } }
        }
        .listStyle(.insetGrouped)
        .overlay {
            if model.loaded, model.rows.isEmpty { ContentUnavailableView("No bots yet", systemImage: "face.smiling", description: Text("Make a bot on your computer and it shows here.")) }
        }
        .navigationTitle("MOSS")
        .navigationSubtitle(computer ?? "")
        .task { model.start() }
    }
}

struct PinnedFace: View {
    let row: BotRow
    var body: some View {
        VStack(spacing: 6) {
            ZStack(alignment: .topTrailing) {
                BotFaceView(name: row.bot.name, face: row.bot.face, mood: mood, size: 92)
                if row.unread {
                    Circle().fill(Color.primary).frame(width: 12, height: 12).overlay(Circle().stroke(Color(uiColor: .systemGroupedBackground), lineWidth: 2))
                        .accessibilityHidden(true)
                }
            }
            Text(row.bot.name).font(.subheadline.weight(.medium)).lineLimit(1)
            if let line = row.statusLine {
                Text(line).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
            }
        }
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(row.bot.name)\(row.unread ? ", unread" : "")\(row.statusLine.map { ", " + $0 } ?? "")")
        .accessibilityAddTraits(.isButton)
    }
    private var mood: BotFaceView.Mood { row.statusLine != nil ? .working : (row.bot.state ?? .idle).faceMood }
}

struct BotListRow: View {
    let row: BotRow
    let now: Int64
    var body: some View {
        HStack(spacing: 12) {
            BotFaceView(name: row.bot.name, face: row.bot.face, mood: row.statusLine != nil ? .working : (row.bot.state ?? .idle).faceMood, size: 48)
            VStack(alignment: .leading, spacing: 2) {
                HStack {
                    Text(row.bot.name).font(.headline)
                    Spacer()
                    if row.lastAt > 0 { Text(TimeText.short(at: row.lastAt, now: now)).font(.caption).foregroundStyle(.secondary) }
                }
                Text(line).font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
            }
            if row.unread { Circle().fill(Color.primary).frame(width: 9, height: 9).accessibilityHidden(true) }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(row.bot.name). \(line)\(row.unread ? ". Unread" : "")")
    }
    private var line: String {
        if let s = row.statusLine { return s }
        switch row.bot.state {
        case .asleep?: return row.summary?.last?.text ?? "Asleep: no computer that can run it is on."
        case .paused?: return "Paused"
        default: return row.summary?.last?.text ?? "No messages yet"
        }
    }
}
