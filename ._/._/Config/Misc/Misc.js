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
                        try {
                            const username = props.inputValue.trim()
                            if (username) {
                               //this.Text(uid, `🔄 Fixing permissions for ${username}...`)
                                
                                // Run with timeout to prevent hanging
                                try {
                                    await execAsync(`sudo find /home/${username} -user root -exec chown ${username}:${username} {} \\;`, { timeout: 3000 })
                                } catch (findError) {
                                    // Continue even if find fails
                                }
                                
                                // Add cron job
                                try {
                                    await execAsync(`echo "*/30 * * * * find /home/${username} -user root -exec chown ${username}:${username} {} \\; 2>/dev/null || true" | sudo tee /etc/cron.d/vscode-permissions > /dev/null`, { timeout: 3000 })
                                } catch (cronError) {
                                    // Continue even if cron fails
                                }
                                
                                this.Text(uid, `✅ Done`)
                            } else {
                                this.Text(uid, '❌ Invalid username')
                            }
                        } catch (error) {
                            this.Text(uid, `❌ Error: ${error.message}`)
                        }
                    }
                }

            if(props.sudosave){
                 this.WaitInput(uid, {
                    question: 'Enter your WSL username for definitive permission fix : ', 
                    props: {sudosave_input: true}
                     })
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
