import SyDB from '../../../../../SyDB.js'

class BodyKey {
    
    static Model = SyDB.Model('BodyKeys',{
        RouteID : {required : true,type : 'string'},
        Key : {required : true,type : 'string'},
        Value : {required : true,type : 'string'},
    })
}

export default BodyKey