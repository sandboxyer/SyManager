import SyAPP from '../../SyAPP.js'
import SyDB_Config from './SyDB_Config/SyDB_Config.js'
import Misc from './Misc/Misc.js'

class Config extends SyAPP.Func() {
    constructor(){
        super(
            'config',
            async (props) => {
                let uid = props.session.UniqueID

                this.Button(uid,{name : 'SyDB',path : 'sydb'})
                this.Button(uid,{name : 'SyPM'})
                this.Button(uid,{name : this.TextColor.cyan('Misc'),path : 'misc'})

                this.Button(uid,{name : '← Return',path : 'sy'})

            },
            {linked : [SyDB_Config,Misc]}
        )
    }
}

export default Config
