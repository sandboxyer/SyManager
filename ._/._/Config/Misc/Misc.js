import SyAPP from '../../../SyAPP.js'
import DownloadHUB from '../../._/Util/DownloadHUD.js'
import ClipInstaller from '../../._/Util/clip.js'
import Git from '../../._/Util/Git.js'
import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

class Misc extends SyAPP.Func() {
    constructor(){
        super(
            'misc',
            async (props) => {
                let uid = props.session.UniqueID

                
                if(props.inputValue){
                    
                    if(props.sudosave_input){
                        // Execute the command line here putting the props.inputValue that is the user in the user place
                        try {
                            const username = props.inputValue.trim()
                            if (username) {
                                const command = `sudo find /home -user root -exec chown ${username}:${username} {} \\;`
                                const { stdout, stderr } = await execAsync(command)
                                if (stderr) {
                                    this.Text(uid, `⚠️ Warning: ${stderr}`)
                                }
                                if (stdout) {
                                }
                                this.Text(uid, `✅ Successfully changed ownership of root files to ${username}`)
                            } else {
                                this.Text(uid, '❌ Invalid username provided')
                            }
                        } catch (error) {
                            this.Text(uid, `❌ Error: ${error.message}`)
                        }
                    }
                    
                }

                if(props.downloadhub){
                    await DownloadHUB.Start()
                }

                if(props.clip){
                    const installer = new ClipInstaller();
                    await installer.install();
                }
               
                if(props.gitconfig){
                    await Git.setup()
                }

                if(props.sudosave){
                    this.WaitInput(uid,{question : 'WSL username : ',props : {sudosave_input : true}})
                }

                this.Text(uid,'• Misc Menu')
                
                this.Button(uid,{name : 'DownloadHUD',props : {downloadhub : true}})
                this.Button(uid,{name : 'Git Config',props : {gitconfig : true}})
                await this.DropDown(uid,'windows-drop',async () => {
                    this.Button(uid,{name : 'Clip',props : {clip : true}})
                    this.Button(uid,{name :'WSL | /home sudo save',props : {sudosave : true}})
                },{up_buttontext : 'Windows Toolkit',down_buttontext : 'Windows Toolkit'})
                
               

		this.Button(uid,{name : ' '})
                this.Button(uid,{name : '← Return',path : 'config'})

            }
        )
    }
}

export default Misc