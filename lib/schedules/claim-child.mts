// Process-death regression helper; refuses every target except the isolated fixture.
import { Pool } from 'pg'
import { isE2eTarget } from '../../tests/helpers/e2e-target.mjs'
import { envValue } from '../env/runtime.mjs'
import { ScheduleStore } from './store.ts'
const target=envValue('E2E_DATABASE_URL')
if(!isE2eTarget(target)||target!==envValue('DATABASE_URL')||target!==envValue('MIKKA_DATABASE_URL'))throw new Error('Isolated schedule fixture required')
const pool=new Pool({connectionString:target,max:1})
const store=new ScheduleStore(pool,async(_owner,_workspace,work)=>work({role:'member'}),async()=>null,async()=>{},()=>true,()=>new Date(envValue('SCHEDULE_TEST_CLOCK')!))
console.log(JSON.stringify(await store.claim()))
setInterval(()=>{},1000)
