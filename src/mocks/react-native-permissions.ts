/**
 * react-native-permissions — Expo Go mock
 * Tüm izinler "granted" döner.
 */
export const PERMISSIONS = {
  ANDROID: {
    CAMERA: 'android.permission.CAMERA',
    RECORD_AUDIO: 'android.permission.RECORD_AUDIO',
    READ_EXTERNAL_STORAGE: 'android.permission.READ_EXTERNAL_STORAGE',
    WRITE_EXTERNAL_STORAGE: 'android.permission.WRITE_EXTERNAL_STORAGE',
    READ_MEDIA_IMAGES: 'android.permission.READ_MEDIA_IMAGES',
    POST_NOTIFICATIONS: 'android.permission.POST_NOTIFICATIONS',
    READ_MEDIA_VISUAL_USER_SELECTED: 'android.permission.READ_MEDIA_VISUAL_USER_SELECTED',
  },
  IOS: {
    CAMERA: 'ios.permission.CAMERA',
    MICROPHONE: 'ios.permission.MICROPHONE',
    PHOTO_LIBRARY: 'ios.permission.PHOTO_LIBRARY',
    NOTIFICATIONS: 'ios.permission.NOTIFICATIONS',
  },
};

export const RESULTS = {
  UNAVAILABLE: 'unavailable',
  BLOCKED:     'blocked',
  DENIED:      'denied',
  GRANTED:     'granted',
  LIMITED:     'limited',
};

export const check    = async (_permission: string) => RESULTS.GRANTED;
export const request  = async (_permission: string) => RESULTS.GRANTED;
export const checkMultiple  = async (permissions: string[]) =>
  Object.fromEntries(permissions.map(p => [p, RESULTS.GRANTED]));
export const requestMultiple = async (permissions: string[]) =>
  Object.fromEntries(permissions.map(p => [p, RESULTS.GRANTED]));
export const openSettings = async () => {};

export type Permission = string;
export type PermissionStatus = string;
export default { PERMISSIONS, RESULTS, check, request, checkMultiple, requestMultiple, openSettings };
