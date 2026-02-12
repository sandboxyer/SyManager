import TerminalHUD from '././._/._/._/Util/TerminalHUD.js'
import MainMenu from './._/._/LegacyHUD/MainMenu.js'
import SyDB from './._/SyDB.js'
import SyPM from './._/SyPM.js'
import SyAPP from './._/SyAPP.js'

let instances = new Map([[1,new SyAPP({background : true})]])

instances.delete(1)

function createInstance(config = {}) {
    const id = Date.now() + Math.random();
    instances.set(id, new SyAPP({ background: true, ...config }));
    return id;
  }




class Sy extends SyAPP.Func() {
    constructor(){
        super(
            'sy',
            async (props) => {
                let uid = props.session.UniqueID

                if(props.new_app){
                    createInstance()
                }
                
                instances.forEach(async (e,k) => {
                   await this.DropDown(uid,k.toString(),async () => {
                        this.Button(uid,'test')
                    },{up_buttontext : `${k.toString().substring(k.toString().length-5,k.toString())} | ${e.MainFunc.Name}`, down_buttontext : `${k.toString().substring(k.toString().length-5,k.toString())} | ${e.MainFunc.Name}`})
                })
            
            
               this.Button(uid,{name : this.TextColor.orange('＋ New'),props : {new_app : true}})
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