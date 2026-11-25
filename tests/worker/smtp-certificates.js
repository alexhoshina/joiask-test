import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Generate a private CA and a loopback-only server certificate for this test
// process. No reusable signing or server keys are committed to the repository.
export async function localCertificates() {
  const directory = await mkdtemp(join(tmpdir(), 'joiask-test-smtp-'));
  const bundled = join(process.env.ProgramFiles || 'C:/Program Files', 'Git/usr/bin/openssl.exe');
  const openssl = process.platform === 'win32' && existsSync(bundled) ? bundled : 'openssl';
  const options = {cwd:directory,stdio:'ignore',windowsHide:true};
  const caFile = join(directory,'ca.pem');
  try {
    const config = join(directory,'openssl.cnf');
    await writeFile(config, `[req]
distinguished_name=subject
prompt=no
[subject]
CN=JoiAsk disposable SMTP CA
[ca]
basicConstraints=critical,CA:TRUE
keyUsage=critical,keyCertSign,cRLSign
subjectKeyIdentifier=hash
[server]
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=DNS:localhost,IP:127.0.0.1
`);
    execFileSync(openssl,['req','-new','-x509','-nodes','-newkey','rsa:2048','-sha256','-days','2',
      '-config',config,'-extensions','ca','-keyout','ca.key','-out',caFile],options);
    execFileSync(openssl,['req','-new','-nodes','-newkey','rsa:2048','-subj','/CN=localhost',
      '-config',config,'-keyout','server.key','-out','server.csr'],options);
    execFileSync(openssl,['x509','-req','-in','server.csr','-CA',caFile,'-CAkey','ca.key','-CAcreateserial',
      '-days','2','-sha256','-extfile',config,'-extensions','server','-out','server.pem'],options);
    const key=await readFile(join(directory,'server.key')), cert=await readFile(join(directory,'server.pem'));
    return {caFile,key,cert,cleanup:()=>rm(directory,{recursive:true,force:true})};
  } catch (error) {
    await rm(directory,{recursive:true,force:true});
    throw error;
  }
}
