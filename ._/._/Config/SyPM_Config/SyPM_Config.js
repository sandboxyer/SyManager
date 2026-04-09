import SyAPP from '../../../SyAPP.js'
import SyPM from '../../../SyPM.js'

class SyPM_Config extends SyAPP.Func() {
    constructor(){
        super(
            'sypm',
            async (props) => {
                let uid = props.session.UniqueID

                let processes = SyPM.list()

                processes.forEach(e => {
                    this.Button(uid,`${(e.status == 'Running') ? this.TextColor.green(e.name) : this.TextColor.red(e.name)}`)
                })
               
               
                this.Button(uid,{name : '← Return',path : 'config'})
            }
        )
    }
}

export default SyPM_Config