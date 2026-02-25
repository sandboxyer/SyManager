import SyAPP from '../../../SyAPP.js'
import DownloadHUB from '../../._/Util/DownloadHUD.js'
import ClipInstaller from '../../._/Util/clip.js'
import Git from '../../._/Util/Git.js'


class Misc extends SyAPP.Func() {
    constructor(){
        super(
            'misc',
            async (props) => {
                let uid = props.session.UniqueID

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
                this.Button(uid,{name : 'Clip',props : {clip : true}})
                this.Button(uid,{name : 'Git Config',props : {gitconfig : true}})
               

		this.Button(uid,{name : ' '})
                this.Button(uid,{name : '← Return',path : 'config'})

            }
        )
    }
}

export default Misc
