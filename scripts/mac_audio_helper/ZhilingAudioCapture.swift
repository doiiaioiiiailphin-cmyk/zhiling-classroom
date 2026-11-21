// 知聆课堂 macOS 原生系统内录与设备枚举助手
// - macOS 14.2+ 优先采用 CoreAudio Process Tap（AudioHardwareCreateProcessTap），纯系统音频采集、零录屏弹窗；
// - macOS 13.0–14.1 自动回退 ScreenCaptureKit（SCStream + CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer）；
// 编译命令（仅依赖苹果官方系统框架，零第三方依赖）：
//   swiftc -O -parse-as-library scripts/mac_audio_helper/ZhilingAudioCapture.swift \
//     -framework ScreenCaptureKit -framework CoreAudio -framework CoreMedia \
//     -framework AVFoundation -framework Foundation -o assets/macos/ZhilingAudioCapture
//
// 用法：
//   ZhilingAudioCapture --list-devices                  -> 向 stdout 输出 JSON 设备列表
//   ZhilingAudioCapture --capture [--device-id <uid>]   -> 向 stdout 持续输出 16000 Hz / 16-bit s16le / mono 裸 PCM

import AVFoundation
import CoreAudio
import CoreMedia
import Darwin
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
                // 跳过本助手自建的临时聚合设备
                if name.hasPrefix("ZhilingAudioTapAggregate") || uid.hasPrefix("com.zhiling.tap.") {
                    continue
                }
                if coreAudioChannelCount(deviceID: devID, scope: kAudioDevicePropertyScopeInput) > 0 {
                    let isDef = devID == defaultIn
                    inputs.append(AudioDeviceItem(
                        id: "macos-in:\(uid)",
                        rawId: uid,
                        name: name,
                        isDefault: isDef,
                        isCommunicationsDefault: isDef
                    ))
                }
                if coreAudioChannelCount(deviceID: devID, scope: kAudioDevicePropertyScopeOutput) > 0 {
                    let isDef = devID == defaultOut
                    outputs.append(AudioDeviceItem(
                        id: "macos-loop:\(uid)",
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
            name: "macOS 系统音频内录",
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

/// 统一高精度 PCM 重采样与输出器：将任意采样率/声道的 Float32 或 Int16 AudioBufferList 转为 16kHz mono s16le 写入 stdout。
/// 使用零 ObjC 分配的 POSIX `Darwin.write` 直接写入 STDOUT_FILENO，杜绝实时音频回调内 Foundation/FileHandle 内存泄漏与 SIGPIPE 闪退。
private final class Pcm16MonoEmitter {
    private let targetRate: Double = 16000.0
    private var samplesPerOutput: Double = 3.0
    private var remaining: Double = 3.0
    private var accumulator: Double = 0.0
    private var lastRate: Double = 0.0
    private var outSamples: [Int16] = []
    private(set) var pipeBroken: Bool = false

    init() {
        outSamples.reserveCapacity(1024)
    }

    func emit(bufferList: UnsafePointer<AudioBufferList>, asbd: AudioStreamBasicDescription) {
        if pipeBroken { return }
        let inRate = asbd.mSampleRate > 0 ? asbd.mSampleRate : 48000.0
        if inRate != lastRate {
            lastRate = inRate
            samplesPerOutput = max(1.0, inRate / targetRate)
            remaining = samplesPerOutput
            accumulator = 0.0
        }

        let isFloat = (asbd.mFormatFlags & kAudioFormatFlagIsFloat) != 0
        let isNonInterleaved = (asbd.mFormatFlags & kAudioFormatFlagIsNonInterleaved) != 0
        let bitsPerChannel = Int(asbd.mBitsPerChannel)
        let channels = max(1, Int(asbd.mChannelsPerFrame))

        let abl = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: bufferList))
        guard !abl.isEmpty else { return }

        outSamples.removeAll(keepingCapacity: true)

        if isFloat && bitsPerChannel == 32 {
            if isNonInterleaved {
                guard let firstData = abl[0].mData else { return }
                let frameCount = Int(abl[0].mDataByteSize) / MemoryLayout<Float>.size
                guard frameCount > 0 else { return }
                let chCount = min(channels, abl.count)
                var chPtrs: [UnsafePointer<Float>] = []
                chPtrs.reserveCapacity(chCount)
                for c in 0..<chCount {
                    if let p = abl[c].mData {
                        chPtrs.append(p.assumingMemoryBound(to: Float.self))
                    }
                }
                guard !chPtrs.isEmpty else { return }
                let invCh = 1.0 / Double(chPtrs.count)
                for i in 0..<frameCount {
                    var sum: Double = 0.0
                    for p in chPtrs {
                        sum += Double(p[i])
                    }
                    pushMonoSample(sum * invCh)
                }
                _ = firstData
            } else {
                guard let raw = abl[0].mData else { return }
                let totalFloats = Int(abl[0].mDataByteSize) / MemoryLayout<Float>.size
                let frameCount = totalFloats / channels
                guard frameCount > 0 else { return }
                let ptr = raw.assumingMemoryBound(to: Float.self)
                let invCh = 1.0 / Double(channels)
                for i in 0..<frameCount {
                    var sum: Double = 0.0
                    let base = i * channels
                    for c in 0..<channels {
                        sum += Double(ptr[base + c])
                    }
                    pushMonoSample(sum * invCh)
                }
            }
        } else if !isFloat && bitsPerChannel == 16 {
            guard let raw = abl[0].mData else { return }
            let totalSamples = Int(abl[0].mDataByteSize) / MemoryLayout<Int16>.size
            let frameCount = isNonInterleaved ? totalSamples : (totalSamples / channels)
            guard frameCount > 0 else { return }
            let ptr = raw.assumingMemoryBound(to: Int16.self)
            let invCh = 1.0 / (32768.0 * Double(isNonInterleaved ? 1 : channels))
            for i in 0..<frameCount {
                var sum: Double = 0.0
                if isNonInterleaved {
                    sum = Double(ptr[i])
                } else {
                    let base = i * channels
                    for c in 0..<channels {
                        sum += Double(ptr[base + c])
                    }
                }
                pushMonoSample(sum * invCh)
            }
        }

        if !outSamples.isEmpty {
            outSamples.withUnsafeBytes { rawBuf in
                guard let baseAddr = rawBuf.baseAddress else { return }
                var written = 0
                let total = rawBuf.count
                while written < total {
                    let n = Darwin.write(STDOUT_FILENO, baseAddr.advanced(by: written), total - written)
                    if n > 0 {
                        written += n
                    } else if n < 0 && errno == EINTR {
                        continue
                    } else {
                        pipeBroken = true
                        break
                    }
                }
            }
        }
    }

    private func pushMonoSample(_ sample: Double) {
        let clampedIn = max(-1.0, min(1.0, sample))
        var available = 1.0
        while available > 1e-8 {
            let weight = min(available, remaining)
            accumulator += clampedIn * weight
            remaining -= weight
            available -= weight
            if remaining <= 1e-8 {
                let averaged = max(-1.0, min(1.0, accumulator / samplesPerOutput))
                let scaled = averaged < 0 ? averaged * 32768.0 : averaged * 32767.0
                let i16 = Int16(max(-32768.0, min(32767.0, scaled.rounded())))
                outSamples.append(i16.littleEndian)
                remaining = samplesPerOutput
                accumulator = 0.0
            }
        }
    }
}

// MARK: - macOS 14.2+ CoreAudio Process Tap（纯音频内录，不触发录屏确认弹窗）

@available(macOS 14.2, *)
private final class CoreAudioProcessTapCapture {
    private var tapID: AudioObjectID = AudioObjectID(kAudioObjectUnknown)
    private var aggregateDeviceID: AudioObjectID = AudioObjectID(kAudioObjectUnknown)
    private var ioProcID: AudioDeviceIOProcID?
    private let emitter = Pcm16MonoEmitter()
    private let ioQueue = DispatchQueue(label: "zhiling.coreaudio.tap.io", qos: .userInteractive)

    private static func currentProcessAudioObjectID() -> AudioObjectID? {
        var pid = getpid()
        var objID = AudioObjectID(kAudioObjectUnknown)
        var size = UInt32(MemoryLayout<AudioObjectID>.size)
        var addr = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyTranslatePIDToProcessObject,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        let status = AudioObjectGetPropertyData(
            AudioObjectID(kAudioObjectSystemObject),
            &addr,
            UInt32(MemoryLayout<pid_t>.size),
            &pid,
            &size,
            &objID
        )
        if status == noErr && objID != AudioObjectID(kAudioObjectUnknown) {
            return objID
        }
        return nil
    }

    func start() throws {
        var excluded: [AudioObjectID] = []
        if let selfObj = Self.currentProcessAudioObjectID() {
            excluded.append(selfObj)
        }

        let tapUUID = UUID()
        let tapDesc = CATapDescription(stereoGlobalTapButExcludeProcesses: excluded)
        tapDesc.uuid = tapUUID
        tapDesc.isPrivate = true
        tapDesc.isExclusive = true
        tapDesc.muteBehavior = .unmuted

        var createdTap = AudioObjectID(kAudioObjectUnknown)
        let tapStatus = AudioHardwareCreateProcessTap(tapDesc, &createdTap)
        guard tapStatus == noErr, createdTap != AudioObjectID(kAudioObjectUnknown) else {
            throw NSError(
                domain: "ZhilingAudioCapture",
                code: Int(tapStatus),
                userInfo: [NSLocalizedDescriptionKey: "AudioHardwareCreateProcessTap failed (\(tapStatus))"]
            )
        }
        self.tapID = createdTap

        var asbd = AudioStreamBasicDescription()
        var asbdSize = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        var fmtAddr = AudioObjectPropertyAddress(
            mSelector: kAudioTapPropertyFormat,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        let fmtStatus = AudioObjectGetPropertyData(createdTap, &fmtAddr, 0, nil, &asbdSize, &asbd)
        guard fmtStatus == noErr else {
            stop()
            throw NSError(
                domain: "ZhilingAudioCapture",
                code: Int(fmtStatus),
                userInfo: [NSLocalizedDescriptionKey: "Read kAudioTapPropertyFormat failed (\(fmtStatus))"]
            )
        }

        let aggUID = "com.zhiling.tap.\(UUID().uuidString)"
        let aggDesc: [String: Any] = [
            kAudioAggregateDeviceNameKey: "ZhilingAudioTapAggregate",
            kAudioAggregateDeviceUIDKey: aggUID,
            kAudioAggregateDeviceIsPrivateKey: true,
            kAudioAggregateDeviceIsStackedKey: false,
            kAudioAggregateDeviceTapAutoStartKey: true,
            kAudioAggregateDeviceTapListKey: [
                [
                    kAudioSubTapUIDKey: tapUUID.uuidString,
                    kAudioSubTapDriftCompensationKey: true,
                ]
            ],
        ]

        var aggID = AudioObjectID(kAudioObjectUnknown)
        let aggStatus = AudioHardwareCreateAggregateDevice(aggDesc as CFDictionary, &aggID)
        guard aggStatus == noErr, aggID != AudioObjectID(kAudioObjectUnknown) else {
            stop()
            throw NSError(
                domain: "ZhilingAudioCapture",
                code: Int(aggStatus),
                userInfo: [NSLocalizedDescriptionKey: "AudioHardwareCreateAggregateDevice failed (\(aggStatus))"]
            )
        }
        self.aggregateDeviceID = aggID

        let capturedAsbd = asbd
        var procID: AudioDeviceIOProcID?
        let ioStatus = AudioDeviceCreateIOProcIDWithBlock(&procID, aggID, ioQueue) {
            [weak self] _, inInputData, _, _, _ in
            autoreleasepool {
                guard let self = self else { return }
                self.emitter.emit(bufferList: inInputData, asbd: capturedAsbd)
            }
        }
        guard ioStatus == noErr, let validProcID = procID else {
            stop()
            throw NSError(
                domain: "ZhilingAudioCapture",
                code: Int(ioStatus),
                userInfo: [NSLocalizedDescriptionKey: "AudioDeviceCreateIOProcIDWithBlock failed (\(ioStatus))"]
            )
        }
        self.ioProcID = validProcID

        let startStatus = AudioDeviceStart(aggID, validProcID)
        guard startStatus == noErr else {
            stop()
            throw NSError(
                domain: "ZhilingAudioCapture",
                code: Int(startStatus),
                userInfo: [NSLocalizedDescriptionKey: "AudioDeviceStart failed (\(startStatus))"]
            )
        }
    }

    var isPipeBroken: Bool {
        return emitter.pipeBroken
    }

    func isDeviceAlive() -> Bool {
        guard aggregateDeviceID != AudioObjectID(kAudioObjectUnknown) else { return false }
        var alive: UInt32 = 0
        var size = UInt32(MemoryLayout<UInt32>.size)
        var addr = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyDeviceIsAlive,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        let st = AudioObjectGetPropertyData(aggregateDeviceID, &addr, 0, nil, &size, &alive)
        return st == noErr && alive != 0
    }

    func stop() {
        if let proc = ioProcID, aggregateDeviceID != AudioObjectID(kAudioObjectUnknown) {
            AudioDeviceStop(aggregateDeviceID, proc)
            AudioDeviceDestroyIOProcID(aggregateDeviceID, proc)
            ioProcID = nil
        }
        if aggregateDeviceID != AudioObjectID(kAudioObjectUnknown) {
            AudioHardwareDestroyAggregateDevice(aggregateDeviceID)
            aggregateDeviceID = AudioObjectID(kAudioObjectUnknown)
        }
        if tapID != AudioObjectID(kAudioObjectUnknown) {
            AudioHardwareDestroyProcessTap(tapID)
            tapID = AudioObjectID(kAudioObjectUnknown)
        }
    }
}

// MARK: - macOS 13.0–14.1 ScreenCaptureKit 回退方案

@available(macOS 13.0, *)
private final class AudioStreamWriter: NSObject, SCStreamOutput, SCStreamDelegate {
    private let emitter = Pcm16MonoEmitter()

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of outputType: SCStreamOutputType) {
        autoreleasepool {
            guard outputType == .audio, CMSampleBufferIsValid(sampleBuffer) else { return }
            guard let desc = CMSampleBufferGetFormatDescription(sampleBuffer),
                  let asbdPtr = CMAudioFormatDescriptionGetStreamBasicDescription(desc) else {
                return
            }
            let asbd = asbdPtr.pointee

            var listSizeNeeded = 0
            let probeStatus = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
                sampleBuffer,
                bufferListSizeNeededOut: &listSizeNeeded,
                bufferListOut: nil,
                bufferListSize: 0,
                blockBufferAllocator: nil,
                blockBufferMemoryAllocator: nil,
                flags: 0,
                blockBufferOut: nil
            )
            guard probeStatus == noErr || probeStatus == kCMSampleBufferError_BufferHasNoSampleSizes || listSizeNeeded > 0 else {
                return
            }
            let allocSize = max(listSizeNeeded, MemoryLayout<AudioBufferList>.size)
            let rawPtr = UnsafeMutableRawPointer.allocate(
                byteCount: allocSize,
                alignment: MemoryLayout<AudioBufferList>.alignment
            )
            defer { rawPtr.deallocate() }
            let ablPtr = rawPtr.bindMemory(to: AudioBufferList.self, capacity: 1)

            var blockBuffer: CMBlockBuffer?
            let copyStatus = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
                sampleBuffer,
                bufferListSizeNeededOut: nil,
                bufferListOut: ablPtr,
                bufferListSize: allocSize,
                blockBufferAllocator: nil,
                blockBufferMemoryAllocator: nil,
                flags: UInt32(kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment),
                blockBufferOut: &blockBuffer
            )
            guard copyStatus == noErr else { return }
            emitter.emit(bufferList: ablPtr, asbd: asbd)
            _ = blockBuffer
        }
    }

    var isPipeBroken: Bool {
        return emitter.pipeBroken
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        let msg = "MACOS_AUDIO_STREAM_STOPPED: \(error.localizedDescription)\n"
        if let d = msg.data(using: .utf8) {
            try? FileHandle.standardError.write(contentsOf: d)
        }
        Foundation.exit(2)
    }
}

private var activeCleanup: (() -> Void)?

private func installSignalHandlers() {
    signal(SIGPIPE, SIG_IGN)
    signal(SIGTERM) { _ in
        activeCleanup?()
        Foundation.exit(0)
    }
    signal(SIGINT) { _ in
        activeCleanup?()
        Foundation.exit(0)
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

            installSignalHandlers()

            // 1. macOS 14.2+ 优先使用 CoreAudio Process Tap（纯系统音频录制，避免 macOS 15 重复录屏权限弹窗）
            if #available(macOS 14.2, *) {
                let tapCapture = CoreAudioProcessTapCapture()
                do {
                    try tapCapture.start()
                    activeCleanup = { tapCapture.stop() }
                    while true {
                        try await Task.sleep(nanoseconds: 1_000_000_000)
                        if tapCapture.isPipeBroken {
                            tapCapture.stop()
                            Foundation.exit(0)
                        }
                        if !tapCapture.isDeviceAlive() {
                            // 音频路由切换（如蓝牙耳机休眠/重连）导致聚合设备失效时，带退避重试重建 Process Tap
                            tapCapture.stop()
                            var recovered = false
                            for delayNs in [UInt64(400_000_000), UInt64(800_000_000), UInt64(1_500_000_000)] {
                                try await Task.sleep(nanoseconds: delayNs)
                                do {
                                    try tapCapture.start()
                                    recovered = true
                                    break
                                } catch {
                                    tapCapture.stop()
                                }
                            }
                            if !recovered {
                                throw NSError(
                                    domain: "ZhilingAudioCapture",
                                    code: -2,
                                    userInfo: [NSLocalizedDescriptionKey: "Process Tap recovery failed after audio route change"]
                                )
                            }
                        }
                    }
                } catch {
                    let note = "CoreAudio Process Tap unavailable, falling back to ScreenCaptureKit: \(error.localizedDescription)\n"
                    try? FileHandle.standardError.write(contentsOf: Data(note.utf8))
                    tapCapture.stop()
                }
            }

            // 2. macOS 13.x 或 Process Tap 不可用时回退 ScreenCaptureKit
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
                config.sampleRate = 48000
                config.channelCount = 2
                config.width = 2
                config.height = 2
                config.minimumFrameInterval = CMTime(value: 10, timescale: 1)

                let writer = AudioStreamWriter()
                let stream = SCStream(filter: filter, configuration: config, delegate: writer)
                let queue = DispatchQueue(label: "zhiling.audio.capture", qos: .userInteractive)
                try stream.addStreamOutput(writer, type: .audio, sampleHandlerQueue: queue)
                try await stream.startCapture()

                while true {
                    try await Task.sleep(nanoseconds: 1_000_000_000)
                    if writer.isPipeBroken {
                        try? await stream.stopCapture()
                        Foundation.exit(0)
                    }
                }
            } catch {
                let msg = "MACOS_AUDIO_PERMISSION_REQUIRED: 请在「系统设置 → 隐私与安全性 → 录屏与系统录音」中勾选知聆课堂后重试（\(error.localizedDescription)）\n"
                try? FileHandle.standardError.write(contentsOf: Data(msg.utf8))
                Foundation.exit(1)
            }
        }

        let usage = "Usage: ZhilingAudioCapture [--list-devices | --capture [--device-id <uid>]]\n"
        try? FileHandle.standardError.write(contentsOf: Data(usage.utf8))
        Foundation.exit(64)
    }
}
