"use strict";

import { Platform } from 'react-native';
// @ts-expect-error this unfortunately isn't typed or default-exported.
import * as NativeComponentRegistry from 'react-native/Libraries/NativeComponent/NativeComponentRegistry';

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
export function getHostComponent(name, getViewConfig) {
  if (NativeComponentRegistry == null) {
    throw new Error(`NativeComponentRegistry is not available on ${Platform.OS}!`);
  }
  return NativeComponentRegistry.get(name, getViewConfig);
}
//# sourceMappingURL=getHostComponent.js.map