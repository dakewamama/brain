import {Pool} from "pg";
import {HumanTaskService} from "../../src/human/service.js";
const pool=new Pool({connectionString:process.env.TEST_DATABASE_URL});
try{await new HumanTaskService(pool).resolve(process.env.AXIS_OPERATOR_TOKEN!,process.env.TASK_ID!,JSON.parse(process.env.TASK_RESPONSE!));}finally{await pool.end();}
