"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.getHostComponent = getHostComponent;
var _reactNative = require("react-native");
var NativeComponentRegistry = _interopRequireWildcard(require("react-native/Libraries/NativeComponent/NativeComponentRegistry"));
function _getRequireWildcardCache(e) { if ("function" != typeof WeakMap) return null; var r = new WeakMap(), t = new WeakMap(); return (_getRequireWildcardCache = function (e) { return e ? t : r; })(e); }
function _interopRequireWildcard(e, r) { if (!r && e && e.__esModule) return e; if (null === e || "object" != typeof e && "function" != typeof e) return { default: e }; var t = _getRequireWildcardCache(r); if (t && t.has(e)) return t.get(e); var n = { __proto__: null }, a = Object.defineProperty && Object.getOwnPropertyDescriptor; for (var u in e) if ("default" !== u && {}.hasOwnProperty.call(e, u)) { var i = a ? Object.getOwnPropertyDescriptor(e, u) : null; i && (i.get || i.set) ? Object.defineProperty(n, u, i) : n[u] = e[u]; } return n.default = e, t && t.set(e, n), n; }
// @ts-expect-error this unfortunately isn't typed or default-exported.

/**
 * Represents all default props a Nitro HybridView has.
 */

// Due to a React limitation, functions cannot be passed to native directly
// because RN converts them to booleans (`true`). Nitro knows this and just
// wraps functions as objects - the original function is stored in `f`.

/**
 * Represents a React Native view, implemented as a Nitro View, with the given props and methods.
 *
 * @note Every React Native view has a {@linkcode DefaultHybridViewProps.hybridRef hybridRef} which can be used to gain access
 *       to the underlying Nitro {@linkcode HybridView}.
 * @note Every function/callback is wrapped as a `{ f: … }` object.
 * @note Every method can be called on the Ref. Including setting properties directly.
 */

/**
 * Finds and returns a native view (aka "HostComponent") via the given {@linkcode name}.
 *
 * The view is bridged to a native Hybrid Object using Nitro Views.
 */
function getHostComponent(name, getViewConfig) {
  if (NativeComponentRegistry == null) {
    throw new Error(`NativeComponentRegistry is not available on ${_reactNative.Platform.OS}!`);
  }
  return NativeComponentRegistry.get(name, getViewConfig);
}
//# sourceMappingURL=getHostComponent.js.map