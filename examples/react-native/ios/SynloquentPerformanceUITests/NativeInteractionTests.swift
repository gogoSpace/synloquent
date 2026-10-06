import Foundation
import QuartzCore
import XCTest

final class NativeInteractionTests: XCTestCase {
  private var recordedIssues = 0
  private var issueOverflow = false

  override func record(_ issue: XCTIssue) {
    if recordedIssues < 65536 { recordedIssues += 1 }
    else { issueOverflow = true }
    super.record(issue)
  }

  private func request(_ path: String, body: [String: Any]? = nil) throws -> [String: Any] {
    let completed = DispatchSemaphore(value: 0)
    var result: Result<(Data, Int), Error>?
    var request = URLRequest(url: URL(string: "http://127.0.0.1:8767" + path)!)
    request.timeoutInterval = 10
    if let body {
      request.httpMethod = "POST"
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
      let encoded = try JSONSerialization.data(withJSONObject: body)
      guard encoded.count <= 16384 else { throw NSError(domain: "SynloquentNativeInteraction", code: 2) }
      request.httpBody = encoded
    }
    URLSession.shared.dataTask(with: request) { data, response, failure in
      if let failure { result = .failure(failure) }
      else { result = .success((data ?? Data(), (response as? HTTPURLResponse)?.statusCode ?? 0)) }
      completed.signal()
    }.resume()
    guard completed.wait(timeout: .now() + 15) == .success, let result else {
      throw NSError(domain: "SynloquentNativeInteraction", code: 1)
    }
    let (data, status) = try result.get()
    guard status == 200, data.count <= 16384,
          let value = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
      throw NSError(domain: "SynloquentNativeInteraction", code: 3)
    }
    return value
  }

  private func frame(_ value: CGRect) throws -> [String: Double] {
    let fields = ["x": Double(value.origin.x), "y": Double(value.origin.y),
                  "width": Double(value.width), "height": Double(value.height)]
    guard fields.values.allSatisfy({ $0.isFinite && abs($0) <= 1000000 }),
          value.width > 0, value.height > 0 else {
      throw NSError(domain: "SynloquentNativeInteraction", code: 4)
    }
    return fields
  }

  private func target(_ application: XCUIApplication, type: String) throws -> (XCUIElement, [String: Any]) {
    let identifier = type == "input" ? "performance-input" : "performance-scroll"
    let element: XCUIElement
    if type == "input" {
      let candidates = application.textFields.matching(identifier: identifier)
      guard candidates.count == 1 else { throw NSError(domain: "SynloquentNativeInteraction", code: 5) }
      element = candidates.element(boundBy: 0)
    } else {
      let candidates = application.otherElements[identifier].scrollViews
      guard candidates.count == 1 else { throw NSError(domain: "SynloquentNativeInteraction", code: 6) }
      element = candidates.element(boundBy: 0)
    }
    guard element.exists, element.isHittable else { throw NSError(domain: "SynloquentNativeInteraction", code: 7) }
    let elementFrame = element.frame
    var visible = elementFrame.intersection(application.frame)
    let keyboards = application.keyboards
    guard keyboards.count <= 4 else { throw NSError(domain: "SynloquentNativeInteraction", code: 8) }
    if type == "scroll" {
      for index in 0..<keyboards.count {
        let keyboard = keyboards.element(boundBy: index).frame
        if keyboard.intersects(visible) {
          guard keyboard.minY > visible.minY && keyboard.minX <= visible.minX && keyboard.maxX >= visible.maxX else {
            throw NSError(domain: "SynloquentNativeInteraction", code: 9)
          }
          visible.size.height = min(visible.height, keyboard.minY - visible.minY)
        }
      }
      guard visible.height >= 48 else { throw NSError(domain: "SynloquentNativeInteraction", code: 10) }
    }
    return (element, ["type": type, "identifier": identifier, "frame": try frame(elementFrame),
                      "visibleFrame": try frame(visible), "hittable": true])
  }

  private func matches(_ state: [String: Any], phase: String, probe: String) -> Bool {
    return state["phase"] as? String == phase && state["probeIdentity"] as? String == probe &&
      state["finished"] as? Bool != true
  }

  private func completeAction(_ application: XCUIApplication, phase: String, probe: String,
                              type: String, upward: Bool, deadline: Date) throws {
    let (_, initialGeometry) = try target(application, type: type)
    guard matches(try request("/ui/state"), phase: phase, probe: probe) else { return }
    var begin = initialGeometry
    begin["phase"] = phase
    begin["probeIdentity"] = probe
    let action = try request("/ui/action", body: begin)
    guard let identifier = action["id"] as? Int, identifier > 0,
          let token = action["token"] as? String, token.count <= 14,
          token.range(of: "^u[0-9a-z]{1,12}z$", options: .regularExpression) != nil,
          action["phase"] as? String == phase, action["probeIdentity"] as? String == probe,
          action["type"] as? String == type else {
      throw NSError(domain: "SynloquentNativeInteraction", code: 11)
    }
    let identity: [String: Any] = ["actionId": identifier, "phase": phase, "probeIdentity": probe]
    while Date() < deadline {
      let status = try request("/ui/action/status", body: identity)
      if status["completed"] as? Bool == true { return }
      if status["armed"] as? Bool == true { break }
      Thread.sleep(forTimeInterval: 0.05)
    }
    guard Date() < deadline else { throw NSError(domain: "SynloquentNativeInteraction", code: 12) }
    let (element, freshGeometry) = try target(application, type: type)
    var start = freshGeometry.merging(identity) { _, current in current }
    start["nativeMilliseconds"] = CACurrentMediaTime() * 1000
    let started = try request("/ui/action/start", body: start)
    guard started["accepted"] as? Bool == true else { return }
    let issuesBefore = recordedIssues
    if type == "input" { element.typeText(token) }
    else if upward { element.swipeUp() }
    else { element.swipeDown() }
    let finishedNativeMilliseconds = CACurrentMediaTime() * 1000
    var finish = identity
    finish["nativeMilliseconds"] = finishedNativeMilliseconds
    finish["issuesBefore"] = issuesBefore
    finish["issuesAfter"] = recordedIssues
    finish["issueOverflow"] = issueOverflow
    finish["succeeded"] = recordedIssues == issuesBefore && !issueOverflow
    if type == "input" {
      let observedInputValue = element.value
      var inputValueObservation: [String: Any] = [
        "source": "XCUIElement.value", "state": "null", "value": NSNull()
      ]
      if let observedInputValue {
        if let observedInputText = observedInputValue as? String {
          if observedInputText.utf16.prefix(257).count <= 256 {
            inputValueObservation["state"] = "value"
            inputValueObservation["value"] = observedInputText
          } else {
            inputValueObservation["state"] = "exceeds-bound"
          }
        } else {
          inputValueObservation["state"] = "unavailable"
        }
      }
      finish["inputValueObservation"] = inputValueObservation
    }
    let result = try request("/ui/action/finish", body: finish)
    guard result["accepted"] as? Bool == true else { throw NSError(domain: "SynloquentNativeInteraction", code: 13) }
    while Date() < deadline {
      let status = try request("/ui/action/status", body: identity)
      if status["completed"] as? Bool == true { return }
      Thread.sleep(forTimeInterval: 0.05)
    }
    throw NSError(domain: "SynloquentNativeInteraction", code: 14)
  }

  func testActualNativeInputAndScroll() throws {
    continueAfterFailure = false
    let application = XCUIApplication(bundleIdentifier: "com.synloquent.example")
    application.activate()
    XCTAssertTrue(application.textFields["performance-input"].waitForExistence(timeout: 60))
    XCTAssertTrue(application.otherElements["performance-scroll"].scrollViews.element(boundBy: 0).waitForExistence(timeout: 10))
    let configuration = try request("/configuration")
    let measurementSchema = configuration["measurementSchemaVersion"] as? Int
    let calibration = configuration["calibrationRequest"] as? [String: Any]
    let schema2Session = calibration?["sessionName"] as? String
    let schema2Read = measurementSchema == 2 && schema2Session?.range(of: "^synloquent-native-ios-[A-Za-z0-9-]{1,128}$", options: .regularExpression) != nil
    if measurementSchema == 2 { XCTAssertTrue(schema2Read, "Missing immutable schema2 session configuration") }
    let allowedPhases = ["idle", "sdk-import", "reference-import", "large-http"] + (schema2Read ? ["catalog-read"] : [])
    let deadline = Date().addingTimeInterval(900)
    var started = false
    var upward = true
    while Date() < deadline {
      let state = try request("/ui/state")
      let phase = state["phase"] as? String ?? "inactive"
      if state["finished"] as? Bool == true { return }
      guard allowedPhases.contains(phase),
            let probe = state["probeIdentity"] as? String,
            probe.range(of: "^probe-[0-9]{1,12}$", options: .regularExpression) != nil else {
        Thread.sleep(forTimeInterval: 0.05)
        continue
      }
      started = true
      let (input, geometry) = try target(application, type: "input")
      var focus = geometry
      focus["phase"] = phase
      focus["probeIdentity"] = probe
      focus["operation"] = "focus-tap"
      focus["stage"] = "start"
      focus["nativeMilliseconds"] = CACurrentMediaTime() * 1000
      guard try request("/ui/ios/operation", body: focus)["accepted"] as? Bool == true else { continue }
      let issuesBefore = recordedIssues
      input.tap()
      focus["stage"] = "finish"
      focus["nativeMilliseconds"] = CACurrentMediaTime() * 1000
      focus["succeeded"] = recordedIssues == issuesBefore && !issueOverflow
      _ = try request("/ui/ios/operation", body: focus)
      guard matches(try request("/ui/state"), phase: phase, probe: probe) else { continue }
      try completeAction(application, phase: phase, probe: probe, type: "input", upward: upward, deadline: deadline)
      guard matches(try request("/ui/state"), phase: phase, probe: probe) else { continue }
      try completeAction(application, phase: phase, probe: probe, type: "scroll", upward: upward, deadline: deadline)
      upward.toggle()
    }
    XCTAssertTrue(started, "No native UI interaction phase was started")
    XCTFail("Native UI interaction did not finish")
  }
}
