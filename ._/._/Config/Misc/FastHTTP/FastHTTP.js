import SyAPP from "../../../SyAPP.js"
import HTTPClient from "../../._/Util/HTTPClient.js"
import SyDB from '../../../SyDB.js'

class FastHTTP extends SyAPP.Func() {
    constructor(){
        super(
            'fasthttp',
            async (props) => {
                let uid = props.session.UniqueID

                if(!this.Storages.Has(uid,'parentfunc')){this.Storages.Set(uid,'parentfunc',props.session.PreviousPath)}

                this.Text(uid,'FastHTTP')

                await this.DropDown(uid,'mainlayerdrop',async () => {
                    this.Buttons(uid,[
                        {name : 'Route'},
                        {name : 'Group'}
                    ])
                })

                this.Button(uid,'<- Return',{path : this.Storages.Get(uid,'parentfunc')})
            })
        }
    }

export default FastHTTP