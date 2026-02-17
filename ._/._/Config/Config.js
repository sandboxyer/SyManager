import SyAPP from '../../SyAPP.js'
import SyDB_Func from './SyDB/SyDB_Func.js'

class Config extends SyAPP.Func() {
    constructor(){
        super(
            'config',
            async (props) => {
                let uid = props.session.UniqueID

                this.Button(uid,{name : 'SyDB',path : 'sydb'})
                this.Button(uid,{name : 'SyPM'})

                this.Button(uid,{name : '← Return',path : 'sy'})

            },
            {linked : [SyDB_Func]}
        )
    }
}

export default Config