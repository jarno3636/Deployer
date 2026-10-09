// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @notice Immutable, read-only bytecode segment for the Indexio V3.3.8 vault init code.
/// @dev Runtime begins with STOP so the stored bytes cannot be executed as a function.
contract IndexioVaultCodeBlobV338 {
    constructor(bytes memory segment) {
        require(segment.length > 0 && segment.length <= 23_500, "segment size");
        bytes memory runtime = bytes.concat(hex"00", segment);
        assembly ("memory-safe") {
            return(add(runtime, 0x20), mload(runtime))
        }
    }
}
