export const PERMISSIONS = {
  IOS: {
    CAMERA: 'ios.permission.CAMERA',
    MICROPHONE: 'ios.permission.MICROPHONE',
    PHOTO_LIBRARY: 'ios.permission.PHOTO_LIBRARY',
    PHOTO_LIBRARY_ADD_ONLY: 'ios.permission.PHOTO_LIBRARY_ADD_ONLY',
  },
  ANDROID: {
    CAMERA: 'android.permission.CAMERA',
    RECORD_AUDIO: 'android.permission.RECORD_AUDIO',
    READ_EXTERNAL_STORAGE: 'android.permission.READ_EXTERNAL_STORAGE',
    WRITE_EXTERNAL_STORAGE: 'android.permission.WRITE_EXTERNAL_STORAGE',
    READ_MEDIA_IMAGES: 'android.permission.READ_MEDIA_IMAGES',
    POST_NOTIFICATIONS: 'android.permission.POST_NOTIFICATIONS',
  },
};

export const RESULTS = {
  GRANTED: 'granted',
  DENIED: 'denied',
  BLOCKED: 'blocked',
  LIMITED: 'limited',
  UNAVAILABLE: 'unavailable',
};

export const request = async (permission: string) => RESULTS.GRANTED;
export const check = async (permission: string) => RESULTS.GRANTED;
export const requestMultiple = async (permissions: string[]) =>
  permissions.reduce((acc, p) => ({ ...acc, [p]: RESULTS.GRANTED }), {});

export default { PERMISSIONS, RESULTS, request, check, requestMultiple };
