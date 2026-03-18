import { useCallback, useSyncExternalStore } from 'react';
import { getDefaultMMKVInstance } from '../createMMKV/getDefaultMMKVInstance';
export function createMMKVHook(getter) {
    return (key, instance) => {
        const mmkv = instance ?? getDefaultMMKVInstance();
        const value = useSyncExternalStore(useCallback((onStoreChange) => {
            const listener = mmkv.addOnValueChangedListener((changedKey) => {
                if (changedKey === key) {
                    onStoreChange();
                }
            });
            return () => listener.remove();
        }, [key, mmkv]), useCallback(() => getter(mmkv, key), [key, mmkv]), useCallback(() => getter(mmkv, key), [key, mmkv]));
        // update value by user set
        const set = useCallback((v) => {
            const newValue = typeof v === 'function' ? v(getter(mmkv, key)) : v;
            switch (typeof newValue) {
                case 'number':
                case 'string':
                case 'boolean':
                    mmkv.set(key, newValue);
                    break;
                case 'undefined':
                    mmkv.remove(key);
                    break;
                case 'object':
                    if (newValue instanceof ArrayBuffer) {
                        mmkv.set(key, newValue);
                        break;
                    }
                    else {
                        throw new Error(`MMKV: Type object (${newValue}) is not supported!`);
                    }
                default:
                    throw new Error(`MMKV: Type ${typeof newValue} is not supported!`);
            }
        }, [key, mmkv]);
        return [value, set];
    };
}
