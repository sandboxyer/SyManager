import SyDB from './._/SyDB.js'
import SyPM from './._/SyPM.js'
import SyAPP from './._/SyAPP.js'
import Sy from './._/._/Sy.js'

class SyManager {

static DB = SyDB
static PM = SyPM
static APP =  SyAPP
static DefaultFunc = Sy

}


if (import.meta.url === `file://${process.argv[1]}`) {
   let app = new SyAPP(SyManager.DefaultFunc)
    await SyDB.Connect(app.MainFunc.Name)
  }
  
  
  export default SyManager