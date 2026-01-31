import TerminalHUD from '././._/._/._/Util/TerminalHUD.js'
import MainMenu from './._/._/LegacyHUD/MainMenu.js'
import SyDB from './._/SyDB.js'
import SyPM from './._/SyPM.js'
import SyAPP from './._/SyAPP.js'


class SyManager {

static DB = SyDB
static PM = SyPM
static APP =  SyAPP

}

let HUD

if (import.meta.url.endsWith(process.argv[1]) || process.argv[1] === import.meta.url.replace('file://', '')) {
    let args = process.argv.slice(2)
    if (args.length === 0) {
        HUD = new TerminalHUD()
        HUD.displayMenu(MainMenu)
   
    }
}   

export default HUD