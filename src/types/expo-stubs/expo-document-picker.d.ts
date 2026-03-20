declare module 'expo-document-picker' {
  export interface DocumentPickerAsset {
    uri:   string;
    name:  string;
    size?: number;
    mimeType?: string;
  }
  export interface DocumentPickerResult {
    canceled: boolean;
    assets?: DocumentPickerAsset[];
  }
  export function getDocumentAsync(options?: {
    type?: string | string[];
    copyToCacheDirectory?: boolean;
    multiple?: boolean;
  }): Promise<DocumentPickerResult>;
}
