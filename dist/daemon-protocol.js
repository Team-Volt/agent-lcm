export const DAEMON_PROTOCOL_VERSION = 2;
// Older clients compare only this value. Change it whenever the protocol becomes incompatible.
export const LEGACY_COMPATIBLE_DAEMON_VERSION = "0.1.0";
export function daemonProtocolCompatible(status) {
    return status.protocol_version === DAEMON_PROTOCOL_VERSION
        || (status.protocol_version === undefined && status.version === LEGACY_COMPATIBLE_DAEMON_VERSION);
}
