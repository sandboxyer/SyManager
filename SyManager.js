import TerminalHUD from '././._/._/._/Util/TerminalHUD.js'
import MainMenu from './._/._/LegacyHUD/MainMenu.js'
import SyDB from './._/SyDB.js'
import SyPM from './._/SyPM.js'
import SyAPP from './._/SyAPP.js'


class Sy extends SyAPP.Func() {
    constructor(){
        super(
            'sy',
            async (props) => {
                let uid = props.session.UniqueID
                
                this.Button(uid,{name : 'teste',jumpTo:1})
                this.Button(uid,{name : 'test2'})


                await this.DropDown(uid,'drop-new-func',() => {
                    this.Buttons(uid,[{name : 'teste1'},{name : 'teste2'}])
                },{
                    up_buttontext : 'New',
                    down_buttontext : 'New',
                    up_emoji : '＋',
                    down_emoji : '',
                })
                this.Button(uid,{name:'⚙️  Config'})



            }
        )
    } 
}


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