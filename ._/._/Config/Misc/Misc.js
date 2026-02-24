import SyAPP from '../../../SyAPP.js'
import DownloadHUB from '../../._/Util/DownloadHUD.js'


class Misc extends SyAPP.Func() {
    constructor(){
        super(
            'misc',
            async (props) => {
                let uid = props.session.UniqueID

                if(props.downloadhub){
                    await DownloadHUB.Start()
                }

                this.Text(uid,'• Misc Menu')
			
                this.Button(uid,{name : 'DownloadHUD',props : {downloadhub : true}})
		this.Button(uid,{name : ' '})
                this.Button(uid,{name : '← Return',path : 'config'})

            }
        )
    }
}

export default Misc
