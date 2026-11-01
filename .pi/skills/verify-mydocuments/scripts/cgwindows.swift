#!/usr/bin/env swift
// 画面上の窓の一覧を JSON で出す（CGWindowListCopyWindowInfo）。読み取りだけで、キー入力・マウス操作は送らない。
// 使い方: swift cgwindows.swift  （tauri.mjs が呼ぶ）
import CoreGraphics
import Foundation

let list = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]] ?? []
var out: [[String: Any]] = []
for w in list {
  let b = w[kCGWindowBounds as String] as? [String: Any] ?? [:]
  out.append([
    "id": w[kCGWindowNumber as String] as? Int ?? -1,
    "pid": w[kCGWindowOwnerPID as String] as? Int ?? -1,
    "owner": w[kCGWindowOwnerName as String] as? String ?? "",
    "name": w[kCGWindowName as String] as? String ?? "",
    "layer": w[kCGWindowLayer as String] as? Int ?? -1,
    "onscreen": w[kCGWindowIsOnscreen as String] as? Bool ?? false,
    "width": b["Width"] as? Double ?? 0,
    "height": b["Height"] as? Double ?? 0,
  ])
}
let data = try JSONSerialization.data(withJSONObject: out)
print(String(data: data, encoding: .utf8)!)
