export { knownSecrets, Secret } from './secret.ts';
export {
  createVault,
  isVaultRef,
  parseVaultRef,
  VAULT_DIR,
  VAULT_FILE,
  VAULT_PREFIX,
  VaultError,
  type Vault,
  type VaultErrorCode,
  type VaultOptions,
} from './vault.ts';
export { hashMasterPassword, isMasterPasswordHash, MASTER_PASSWORD_REF, MAX_MASTER_PASSWORD, MIN_MASTER_PASSWORD, verifyMasterPassword } from './master.ts';
