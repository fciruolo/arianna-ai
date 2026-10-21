// The types of noVNC 1.7.0 (D-269), only the parts the chat uses: the package
// ships none, and @types/novnc__novnc stops at 1.6 with the old path lib/rfb.
declare module '@novnc/novnc' {
  export interface RFBOptions {
    shared?: boolean;
    wsProtocols?: string[];
  }

  export interface RFBDisconnectDetail {
    /** False when the connection ended in an error or without the server's close. */
    clean: boolean;
  }

  export interface RFBSecurityFailureDetail {
    status: number;
    reason?: string;
  }

  export interface RFBEventMap {
    connect: CustomEvent<Record<string, never>>;
    disconnect: CustomEvent<RFBDisconnectDetail>;
    securityfailure: CustomEvent<RFBSecurityFailureDetail>;
  }

  export default class RFB {
    constructor(target: HTMLElement, urlOrChannel: string | WebSocket, options?: RFBOptions);
    viewOnly: boolean;
    scaleViewport: boolean;
    resizeSession: boolean;
    clipViewport: boolean;
    focusOnClick: boolean;
    qualityLevel: number;
    compressionLevel: number;
    disconnect(): void;
    /** Without `down`, a press and a release; nothing in view only. */
    sendKey(keysym: number, code: string | null, down?: boolean): void;
    focus(options?: FocusOptions): void;
    addEventListener<K extends keyof RFBEventMap>(type: K, listener: (event: RFBEventMap[K]) => void): void;
    removeEventListener<K extends keyof RFBEventMap>(type: K, listener: (event: RFBEventMap[K]) => void): void;
  }
}
