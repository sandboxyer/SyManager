import SyAPP from '../../../../SyAPP.js'
import HTTPClient from "../../../._/Util/HTTPClient.js"
import SyDB from '../../../../SyDB.js'
import Route from './entities/Route.js'
import Group from './entities/Group.js'

class FastHTTP extends SyAPP.Func() {
    constructor(){
        super(
            'fasthttp',
            async (props) => {
                let uid = props.session.UniqueID

                if(!this.Storages.Has(uid,'parentfunc')){this.Storages.Set(uid,'parentfunc',props.session.PreviousPath)}

                let NewDropDown = async (ownerid) => {

                }

                this.Text(uid,'FastHTTP')

                await this.Page(uid,'',async () => {

                    if(props.newroute){
                        await Route.New('New Route')
                    }

                    if(props.removeroute){
                        Route.Model.delete(props.removeroute)
                    }

                    let routes = await Route.Model.find()

                    for (const [index, route] of routes.entries()) {
                        await this.DropDown(uid,route._id,async () => {
                            this.Buttons(uid,[
                                {name : 'Run'},
                                {name : 'Edit'},
                                {name : 'Remove',props : {removeroute : route._id}}
                            ])
                        },{up_buttontext : `${route.Name} ${this.TextColor.white('|')} ${HTTPClient.colorHttpMethod(route.Method)} | ${this.TextColor.cyan(route.Url)}`,down_buttontext : `${route.Name} ${this.TextColor.white('|')} ${HTTPClient.colorHttpMethod(route.Method)} | ${this.TextColor.cyan(route.Url)}`})
                      }

                   this.Button(uid,' ')
                   this.Button(uid,'+ New',{props : {newroute : true}})

                })


                await this.Page(uid,'env',async () => {

                  this.Button(uid,'teste1')


                })


                await this.Page(uid,'globalvar',async () => {

                    this.Button(uid,'teste2')


                })



        


                this.Button(uid,this.TextColor.blue('――――――――――――――――――――――――――――――――――――――――――――――'))
                this.Buttons(uid,[
                    {name :'<- Return',path : this.Storages.Get(uid,'parentfunc')},
                    {name : (props.page == '' || !props.page) ? this.TextColor.yellow('Home') : 'Home' ,props : {page : ''}},
                    {name : (props.page == 'env') ? this.TextColor.yellow('Env') : 'Env' ,props : {page : 'env'}},
                    {name : (props.page == 'globalvar') ? this.TextColor.yellow('Global Variables') : 'Global Variables'  ,props : {page : 'globalvar'}}
                ])
            })
        }
    }

export default FastHTTP