export declare function isPrivateIp(ip: string): boolean;
export interface PinnedUrl {
    originalUrl: string;
    protocol: string;
    hostname: string;
    pinnedIp: string;
    port: number;
    pathname: string;
    search: string;
}
export declare function validateAndPinUrl(rawUrl: string, allowPrivate?: boolean): Promise<PinnedUrl>;
