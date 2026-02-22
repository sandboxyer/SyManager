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
    new SyAPP({mainfunc : SyManager.DefaultFunc})
  }
  
  
  export default SyManager