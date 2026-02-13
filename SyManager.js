import TerminalHUD from '././._/._/._/Util/TerminalHUD.js'
import MainMenu from './._/._/LegacyHUD/MainMenu.js'
import SyDB from './._/SyDB.js'
import SyPM from './._/SyPM.js'
import SyAPP from './._/SyAPP.js'

let instances = new Map([['1','']]);

instances.delete('1');

// Helper function to generate unique draft name
function generateDraftName() {
  let counter = 1;
  let name;
  do {
    name = `Draft ${counter}`;
    counter++;
  } while (instances.has(name));
  return name;
}

function createInstance(config = {}) {
  // Use provided name or generate a draft name
  let instanceName = config.name || generateDraftName();
  
  // If provided name already exists, append number to make it unique
  if (config.name && instances.has(config.name)) {
    let counter = 1;
    let baseName = config.name;
    do {
      instanceName = `${baseName} (${counter})`;
      counter++;
    } while (instances.has(instanceName));
  }
  
  // Remove name from config to avoid passing it to SyAPP constructor
  const { name, ...appConfig } = config;
  
  instances.set(instanceName,new SyAPP({ background: true, ...appConfig }));
  return instanceName;
}

function renameInstance(oldName, newName) {
  if (!instances.has(oldName)) {
    throw new Error(`Instance '${oldName}' not found`);
  }
  
  if (instances.has(newName)) {
    throw new Error(`Instance name '${newName}' already exists`);
  }
  
  const instance = instances.get(oldName);
  instances.delete(oldName);
  instances.set(newName, instance);
  
  return newName;
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
                

                if(props.new_selection){
                    if(this.Storages.Has(uid,'minidrop_selected')){
                        if(this.Storages.Get(uid,'minidrop_selected') == props.new_selection){
                            this.Storages.Delete(uid,'minidrop_selected')
                        } else {
                            this.Storages.Set(uid,'minidrop_selected',props.new_selection)
                        } 
                    } else {
                        this.Storages.Set(uid,'minidrop_selected',props.new_selection)
                    }
                    
                }

                this.Text(uid,this.Storages.Get(uid,'minidrop_selected') || '')
                
                instances.forEach(async (e,k) => {
                    this.Button(uid,{name : this.TextColor.red(k),props : {new_selection : k}})
                    if(this.Storages.Has(uid,'minidrop_selected')){
                        if(this.Storages.Get(uid,'minidrop_selected') == k){
                            this.SideButton(uid,{name : 'testing'})
                            this.SideButton(uid,{name : 'testing'})
                        }
                    }
               })
            
            
               this.Button(uid,{name : this.TextColor.orange('＋ New'),jumpTo: 1,props : {new_app : true}})
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

