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

// If this file is run directly, execute the CLI
if (import.meta.url === `file://${process.argv[1]}`) {
    new SyAPP({mainfunc : SyManager.DefaultFunc})
  }
  
  
  export default SyManager