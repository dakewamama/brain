import {spawnSync} from 'node:child_process';
import {readdirSync} from 'node:fs';
if(!process.env.TEST_DATABASE_URL)throw new Error('TEST_DATABASE_URL is required; PostgreSQL tests must not silently skip');
const files=['tests/cases','tests/gateway'].flatMap(dir=>readdirSync(dir).filter(f=>f.endsWith('.test.ts')).map(f=>`${dir}/${f}`));
const result=spawnSync(process.execPath,['node_modules/tsx/dist/cli.mjs','--test','--test-concurrency=1',...files],{stdio:'inherit'});
process.exitCode=result.status??1;
