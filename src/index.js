const core = require("@actions/core");
const request  = require('./httpClient');
const fs = require('fs');
const { execSync } = require("child_process");

async function main() {

  // inputs from action
  const vaultUrl = core.getInput('vaultUrl', { required: true });
  const roleId = core.getInput('roleId', { required: true });
  const secretId = core.getInput('secretId', { required: true });
  const rolesetPath = core.getInput('rolesetPath', { required: true });
  const script = core.getInput('script', { required: true });
  const vaultAuthPayload = `{"role_id": "${roleId}", "secret_id": "${secretId}"}`;

  // authenticate to vault
  var vaultToken = await getVaultToken(vaultUrl, vaultAuthPayload);
  var { leaseId, key } = await getLeaseAndKey(vaultUrl, rolesetPath, vaultToken);

  try {

    // add service account private key json file to container 
    fs.writeFileSync('sa-key.json', key, (error) => {
      if (error) throw error;
    });

    // auth to GCP with service account
    execSync('gcloud auth activate-service-account --key-file sa-key.json', (error, stdout, stderr) => {
      if (error) {
        core.error(`exec error: ${error}`);
        throw error;
      }
      core.info(`stdout: ${stdout}`);
      core.error(`stderr: ${stderr}`);
    });

    // execute provided script
    core.info(`Executing script: ${script}`);
    execSync(script, (error, stdout, stderr) => {
      if (error) {
        core.error(`exec error: ${error}`);
        throw error;
      }
      core.info(`stdout: ${stdout}`);
      core.error(`stderr: ${stderr}`);
    });

    // delete key json file
    fs.unlinkSync('sa-key.json', (error) => {
      if (error) throw error;
    });

  } catch (error) {
    core.setFailed(error.message);
  } finally {
    // release service account
    await revokeLease(vaultUrl, leaseId, vaultToken);
  }
}

async function getVaultToken(vaultUrl, vaultAuthPayload) {
  core.info(`Authenticating to vault`);
  const authResponse = await request(
    `${vaultUrl}/v1/auth/approle/login`,
    "POST",
    vaultAuthPayload,
    ""
  );

  var statusCode = authResponse.status;
  if (statusCode >= 400) {
    core.setFailed(`Failed to login via the provided approle with status code: ${statusCode}`);
    process.exit(1);
  }

  var data = authResponse.data;
  return data.auth.client_token;
}

async function getLeaseAndKey(vaultUrl, rolesetPath, vaultToken) {
  core.info(`Activating service account`);
  const serviceAccountResponse = await request(
    `${vaultUrl}/v1/${rolesetPath}`,
    "GET",
    "",
    { 'X-Vault-Token': vaultToken }
  );

  var statusCode = serviceAccountResponse.status;
  if (statusCode >= 400) {
    core.setFailed(`Failed to access provided roleset path with status code: ${statusCode}`);
    process.exit(1);
  }

  var saData = serviceAccountResponse.data;
  var key = Buffer.from(saData.data.private_key_data, 'base64');
  var leaseId = saData.lease_id;
  return { leaseId, key };
}

async function revokeLease(vaultUrl, leaseId, vaultToken) {
  core.info(`Revoking lease ${leaseId}`);
  const revokeResponse = await request(
    `${vaultUrl}/v1/sys/leases/revoke`,
    "PUT",
    `{"lease_id": "${leaseId}"}`,
    { 'X-Vault-Token': vaultToken }
  );

  var statusCode = revokeResponse.status;
  if (statusCode == 204) {
    core.info(`Successfully revoked lease: ${leaseId}`);
  }
  else {
    // technically the entire script still executed, but the lease is still hanging around, so don't fail the whole run
    core.info(`Failed to revoke key with ${statusCode} on lease: ${leaseId}`);
  }
}

main();
