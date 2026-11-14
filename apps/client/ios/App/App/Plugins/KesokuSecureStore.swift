import Foundation
import Capacitor
import Security

/// Small Keychain-backed key/value store for device credentials.
///
/// Items are generic passwords under the service `dev.kesoku.app.secure-store` in the app's
/// default keychain access group (`<APPLE_TEAM_ID>.dev.kesoku.app`, see App.entitlements),
/// readable after the first unlock following a reboot (`kSecAttrAccessibleAfterFirstUnlock`)
/// so the app can reconnect when brought to the foreground.
///
/// JS API: `get({key}) -> {value: string|null}`, `set({key, value})`, `remove({key})`.
@objc(KesokuSecureStorePlugin)
public class KesokuSecureStorePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "KesokuSecureStorePlugin"
    public let jsName = "KesokuSecureStore"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "get", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "set", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "remove", returnType: CAPPluginReturnPromise)
    ]

    private static let service = "dev.kesoku.app.secure-store"
    private static let maxValueChars = 64 * 1024
    private static let keyRegex: NSRegularExpression = {
        // Static, valid pattern.
        // swiftlint:disable:next force_try
        return try! NSRegularExpression(pattern: "^[A-Za-z0-9._:-]{1,128}$")
    }()

    private func validKey(_ call: CAPPluginCall) -> String? {
        guard let key = call.getString("key") else {
            call.reject("Invalid key", "INVALID_KEY")
            return nil
        }
        let range = NSRange(key.startIndex..<key.endIndex, in: key)
        guard Self.keyRegex.firstMatch(in: key, options: [], range: range) != nil else {
            call.reject("Invalid key", "INVALID_KEY")
            return nil
        }
        return key
    }

    private func baseQuery(_ key: String) -> [String: Any] {
        return [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Self.service,
            kSecAttrAccount as String: key
        ]
    }

    @objc func get(_ call: CAPPluginCall) {
        guard let key = validKey(call) else { return }
        var query = baseQuery(key)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        switch status {
        case errSecSuccess:
            if let data = item as? Data, let value = String(data: data, encoding: .utf8) {
                call.resolve(["value": value])
            } else {
                call.resolve(["value": NSNull()])
            }
        case errSecItemNotFound:
            call.resolve(["value": NSNull()])
        default:
            call.reject("Secure store unavailable", "UNAVAILABLE", nil, ["status": Int(status)])
        }
    }

    @objc func set(_ call: CAPPluginCall) {
        guard let key = validKey(call) else { return }
        guard let value = call.getString("value"), value.count <= Self.maxValueChars else {
            call.reject("Invalid value", "INVALID_VALUE")
            return
        }
        let data = Data(value.utf8)
        let query = baseQuery(key)
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock
        ]

        var status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var add = query
            attributes.forEach { add[$0.key] = $0.value }
            status = SecItemAdd(add as CFDictionary, nil)
        }
        if status == errSecSuccess {
            call.resolve()
        } else {
            call.reject("Write failed", "WRITE_FAILED", nil, ["status": Int(status)])
        }
    }

    @objc func remove(_ call: CAPPluginCall) {
        guard let key = validKey(call) else { return }
        let status = SecItemDelete(baseQuery(key) as CFDictionary)
        if status == errSecSuccess || status == errSecItemNotFound {
            call.resolve()
        } else {
            call.reject("Write failed", "WRITE_FAILED", nil, ["status": Int(status)])
        }
    }
}
