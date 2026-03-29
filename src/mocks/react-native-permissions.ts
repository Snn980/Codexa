// Mock untuk Expo Go
export const PERMISSIONS = {
  ANDROID: {
    CAMERA: 'android.permission.CAMERA',
    RECORD_AUDIO: 'android.permission.RECORD_AUDIO',
    READ_EXTERNAL_STORAGE: 'android.permission.READ_EXTERNAL_STORAGE',
    WRITE_EXTERNAL_STORAGE: 'android.permission.WRITE_EXTERNAL_STORAGE',
  },
};

export const RESULTS = {
  GRANTED: 'granted',
  DENIED: 'denied',
  BLOCKED: 'blocked',
};

export const request = async (permission: string) => RESULTS.GRANTED;
export const check = async (permission: string) => RESULTS.GRANTED;
export const requestMultiple = async (permissions: string[]) => 
  permissions.reduce((acc, p) => ({ ...acc, [p]: RESULTS.GRANTED }), {});

export default { PERMISSIONS, RESULTS, request, check, requestMultiple };
