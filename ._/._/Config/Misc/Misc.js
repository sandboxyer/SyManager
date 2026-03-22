import SyAPP from '../../../SyAPP.js'
import DownloadHUB from '../../._/Util/DownloadHUD.js'
import ClipInstaller from '../../._/Util/clip.js'
import Git from '../../._/Util/Git.js'
import { exec } from 'child_process'
import { promisify } from 'util'
import os from 'os'
import FastHTTP from './FastHTTP/FastHTTP.js'

const execAsync = promisify(exec)

class Misc extends SyAPP.Func() {
    constructor(){
        super(
            'misc',
            async (props) => {
                let uid = props.session.UniqueID

                if (props.sudosave) {
                    let resultMessage = '';
                    
                    try {
                        const username = process.env.SUDO_USER || process.env.USER || os.userInfo().username;
                        const targetDir = '/home'; 

                        this.Text(uid, `⏳ Surgically fixing permissions across ${targetDir} (Git-safe mode)...`);

                        const safeCmd = `
                            chown -R ${username}:${username} ${targetDir} 2>/dev/null || sudo -n chown -R ${username}:${username} ${targetDir} 2>/dev/null;
                            chmod -R u+rwX ${targetDir} 2>/dev/null || sudo -n chmod -R u+rwX ${targetDir} 2>/dev/null
                        `.replace(/\n/g, ' ');

                        await execAsync(safeCmd, { timeout: 300000 }); 
                        
                        try {
                            const cronCmd = `*/5 * * * * chown -R ${username}:${username} ${targetDir} 2>/dev/null; chmod -R u+rwX ${targetDir} 2>/dev/null`;
                            await execAsync(`echo '${cronCmd}' | sudo -n tee /etc/cron.d/vscode-permissions-home > /dev/null`, { timeout: 10000 });
                        } catch (cronError) {}

                        resultMessage = `✅ Vscode save permission applied !`;
                    } catch (error) {
                        resultMessage = `❌ Fatal Error: ${error.message}`;
                    }
                    
                    this.Text(uid, resultMessage);
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
                this.Button(uid,'FastHTTP',{path : 'fasthttp'})
                this.Button(uid,{name : 'Git Config',props : {gitconfig : true}})
                await this.DropDown(uid,'windows-drop',async () => {
                    this.Button(uid,{name : 'Clip',props : {clip : true}})
                    this.Button(uid,{name :'WSL | Vscode save',props : {sudosave : true}})
                },{up_buttontext : 'Windows Toolkit',down_buttontext : 'Windows Toolkit'})
                
                this.Button(uid,{name : ' '})
                this.Button(uid,{name : '← Return',path : 'config'})

            }
        ,{linked : [FastHTTP]})
    }
}

export default Misc
