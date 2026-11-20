// 知聆课堂 macOS 原生系统内录与设备枚举助手（macOS 13.0+ ScreenCaptureKit + CoreAudio）
// 编译命令（仅依赖苹果官方系统框架，零第三方依赖）：
//   swiftc -O -parse-as-library scripts/mac_audio_helper/ZhilingAudioCapture.swift \
//     -framework ScreenCaptureKit -framework CoreAudio -framework CoreMedia \
//     -framework AVFoundation -framework Foundation -o assets/macos/ZhilingAudioCapture
//
// 用法：
//   ZhilingAudioCapture --list-devices  -> 向 stdout 输出 JSON 设备列表
//   ZhilingAudioCapture --capture       -> 向 stdout 持续输出 16000 Hz / 16-bit s16le / mono 裸 PCM

import AVFoundation
import CoreAudio
import CoreMedia
import Foundation
import ScreenCaptureKit

private struct AudioDeviceItem: Codable {
    let id: String
    let rawId: String
    let name: String
    let isDefault: Bool
    let isCommunicationsDefault: Bool
}

private struct DeviceListPayload: Codable {
    let platform: String
    let wasapiSupported: Bool
    let inputs: [AudioDeviceItem]
    let loopbacks: [AudioDeviceItem]
}

private func coreAudioDefaultDeviceID(selector: AudioObjectPropertySelector) -> AudioDeviceID {
    var deviceID = AudioDeviceID(0)
    var propSize = UInt32(MemoryLayout<AudioDeviceID>.size)
    var address = AudioObjectPropertyAddress(
        mSelector: selector,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    let status = AudioObjectGetPropertyData(
        AudioObjectID(kAudioObjectSystemObject),
        &address,
        0,
        nil,
        &propSize,
        &deviceID
    )
    return status == noErr ? deviceID : 0
}

private func coreAudioStringProperty(
    deviceID: AudioDeviceID,
    selector: AudioObjectPropertySelector
) -> String? {
    var unmanaged: Unmanaged<CFString>?
    var propSize = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    var address = AudioObjectPropertyAddress(
        mSelector: selector,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    let status = AudioObjectGetPropertyData(deviceID, &address, 0, nil, &propSize, &unmanaged)
    if status == noErr, let value = unmanaged?.takeRetainedValue() {
        return value as String
    }
    return nil
}

private func coreAudioChannelCount(deviceID: AudioDeviceID, scope: AudioObjectPropertyScope) -> Int {
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyStreamConfiguration,
        mScope: scope,
        mElement: kAudioObjectPropertyElementMain
    )
    var propSize: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(deviceID, &address, 0, nil, &propSize) == noErr,
          propSize > 0 else {
        return 0
    }
    let rawPtr = UnsafeMutableRawPointer.allocate(
        byteCount: Int(propSize),
        alignment: MemoryLayout<AudioBufferList>.alignment
    )
    defer { rawPtr.deallocate() }
    guard AudioObjectGetPropertyData(deviceID, &address, 0, nil, &propSize, rawPtr) == noErr else {
        return 0
    }
    let bufferListPtr = rawPtr.bindMemory(to: AudioBufferList.self, capacity: 1)
    let buffers = UnsafeMutableAudioBufferListPointer(bufferListPtr)
    return buffers.reduce(0) { $0 + Int($1.mNumberChannels) }
}

private func enumerateDevices() -> DeviceListPayload {
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDevices,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var propSize: UInt32 = 0
    var inputs: [AudioDeviceItem] = []
    var outputs: [AudioDeviceItem] = []

    let defaultIn = coreAudioDefaultDeviceID(selector: kAudioHardwarePropertyDefaultInputDevice)
    let defaultOut = coreAudioDefaultDeviceID(selector: kAudioHardwarePropertyDefaultOutputDevice)

    if AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &propSize) == noErr,
       propSize > 0 {
        let count = Int(propSize) / MemoryLayout<AudioDeviceID>.size
        var ids = Array(repeating: AudioDeviceID(0), count: count)
        if AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &propSize, &ids) == noErr {
            for devID in ids {
                let uid = coreAudioStringProperty(deviceID: devID, selector: kAudioDevicePropertyDeviceUID) ?? String(devID)
                let name = coreAudioStringProperty(deviceID: devID, selector: kAudioObjectPropertyName) ?? uid
                if coreAudioChannelCount(deviceID: devID, scope: kAudioDevicePropertyScopeInput) > 0 {
                    let isDef = devID == defaultIn
                    inputs.append(AudioDeviceItem(
                        id: uid,
                        rawId: uid,
                        name: name,
                        isDefault: isDef,
                        isCommunicationsDefault: isDef
                    ))
                }
                if coreAudioChannelCount(deviceID: devID, scope: kAudioDevicePropertyScopeOutput) > 0 {
                    let isDef = devID == defaultOut
                    outputs.append(AudioDeviceItem(
                        id: uid,
                        rawId: uid,
                        name: name,
                        isDefault: isDef,
                        isCommunicationsDefault: isDef
                    ))
                }
            }
        }
    }

    var supported = false
    if #available(macOS 13.0, *) {
        supported = true
    }

    if outputs.isEmpty && supported {
        outputs.append(AudioDeviceItem(
            id: "default",
            rawId: "default",
            name: "macOS 系统音频 (ScreenCaptureKit)",
            isDefault: true,
            isCommunicationsDefault: true
        ))
    }

    return DeviceListPayload(
        platform: "darwin",
        wasapiSupported: supported,
        inputs: inputs,
        loopbacks: outputs
    )
}

@available(macOS 13.0, *)
private final class AudioStreamWriter: NSObject, SCStreamOutput, SCStreamDelegate {
    private let targetFormat = AVAudioFormat(
        commonFormat: .pcmFormatInt16,
        sampleRate: 16000,
        channels: 1,
        interleaved: true
    )!
    private var converter: AVAudioConverter?
    private var lastInputFormat: AVAudioFormat?
    private let stdoutHandle = FileHandle.standardOutput

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of outputType: SCStreamOutputType) {
        guard outputType == .audio, CMSampleBufferIsValid(sampleBuffer) else { return }
        guard let desc = CMSampleBufferGetFormatDescription(sampleBuffer),
              let asbdPtr = CMAudioFormatDescriptionGetStreamBasicDescription(desc) else {
            return
        }
        var asbd = asbdPtr.pointee
        guard let inFormat = AVAudioFormat(streamDescription: &asbd) else { return }
        let frameCount = AVAudioFrameCount(CMSampleBufferGetNumSamples(sampleBuffer))
        guard frameCount > 0, let inBuffer = AVAudioPCMBuffer(pcmFormat: inFormat, frameCapacity: frameCount) else {
            return
        }
        inBuffer.frameLength = frameCount

        let status = CMSampleBufferCopyPCMDataIntoAudioBufferList(
            sampleBuffer,
            at: 0,
            frameCount: Int32(frameCount),
            into: inBuffer.mutableAudioBufferList
        )
        guard status == noErr else { return }

        if converter == nil || lastInputFormat != inFormat {
            converter = AVAudioConverter(from: inFormat, to: targetFormat)
            lastInputFormat = inFormat
        }
        guard let converter = converter else { return }

        let ratio = targetFormat.sampleRate / max(1.0, inFormat.sampleRate)
        let outCapacity = AVAudioFrameCount(ceil(Double(frameCount) * ratio)) + 64
        guard let outBuffer = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: outCapacity) else {
            return
        }

        var consumed = false
        var convertError: NSError?
        converter.convert(to: outBuffer, error: &convertError) { _, outStatus in
            if consumed {
                outStatus.pointee = .noDataNow
                return nil
            }
            consumed = true
            outStatus.pointee = .haveData
            return inBuffer
        }

        guard convertError == nil, outBuffer.frameLength > 0,
              let int16Ptr = outBuffer.int16ChannelData?[0] else {
            return
        }
        let byteCount = Int(outBuffer.frameLength) * MemoryLayout<Int16>.size
        let data = Data(bytes: int16Ptr, count: byteCount)
        try? stdoutHandle.write(contentsOf: data)
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        let msg = "MACOS_AUDIO_STREAM_STOPPED: \(error.localizedDescription)\n"
        if let d = msg.data(using: .utf8) {
            try? FileHandle.standardError.write(contentsOf: d)
        }
        Foundation.exit(2)
    }
}

@main
struct ZhilingAudioCaptureMain {
    static func main() async {
        let args = CommandLine.arguments
        if args.contains("--list-devices") {
            let payload = enumerateDevices()
            let encoder = JSONEncoder()
            if let data = try? encoder.encode(payload) {
                try? FileHandle.standardOutput.write(contentsOf: data)
            }
            return
        }

        if args.contains("--capture") {
            guard #available(macOS 13.0, *) else {
                let msg = "MACOS_VERSION_UNSUPPORTED: 系统内录需要 macOS 13.0 及以上版本\n"
                try? FileHandle.standardError.write(contentsOf: Data(msg.utf8))
                Foundation.exit(3)
            }
            do {
                let shareable = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
                guard let display = shareable.displays.first else {
                    let msg = "MACOS_NO_DISPLAY: 未检测到可用显示器上下文\n"
                    try? FileHandle.standardError.write(contentsOf: Data(msg.utf8))
                    Foundation.exit(4)
                }
                let filter = SCContentFilter(display: display, excludingWindows: [])
                let config = SCStreamConfiguration()
                config.capturesAudio = true
                config.excludesCurrentProcessAudio = true
                config.sampleRate = 16000
                config.channelCount = 1
                // 极小化视频帧开销（ScreenCaptureKit 需附带显示过滤器，设最低帧率以零 GPU/CPU 负担）
                config.width = 2
                config.height = 2
                config.minimumFrameInterval = CMTime(value: 10, timescale: 1)

                let writer = AudioStreamWriter()
                let stream = SCStream(filter: filter, configuration: config, delegate: writer)
                let queue = DispatchQueue(label: "zhiling.audio.capture", qos: .userInteractive)
                try stream.addStreamOutput(writer, type: .audio, sampleHandlerQueue: queue)
                try await stream.startCapture()

                signal(SIGTERM) { _ in Foundation.exit(0) }
                signal(SIGINT) { _ in Foundation.exit(0) }

                while true {
                    try await Task.sleep(nanoseconds: 1_000_000_000)
                }
            } catch {
                let msg = "MACOS_AUDIO_PERMISSION_REQUIRED: 请在「系统设置 → 隐私与安全性 → 屏幕与系统音频录制」中勾选知聆课堂后重试（\(error.localizedDescription)）\n"
                try? FileHandle.standardError.write(contentsOf: Data(msg.utf8))
                Foundation.exit(1)
            }
        }

        let usage = "Usage: ZhilingAudioCapture [--list-devices | --capture]\n"
        try? FileHandle.standardError.write(contentsOf: Data(usage.utf8))
        Foundation.exit(64)
    }
}
